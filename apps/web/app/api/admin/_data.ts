import { loadWorkTypeCatalogMetadata } from "@/app/lib/server/work-catalog";
import { parseReportTemplate, parseEvidencePolicy } from "@/app/lib/report-requirements";
import type { SystemRole, SystemRoleId } from "@/app/admin/role-data";
import type { SystemUser, SystemUserStatus } from "@/app/admin/user-data";
import type { VerificationMethodId, WorkTypeRecord } from "@/app/admin/work-type-data";
import type { WorkScheduleRecord } from "@/app/admin/work-schedule-data";

export async function listAdminUsers(database: D1Database, organizationId: string): Promise<SystemUser[]> {
  const result = await database.prepare(`SELECT users.id, users.display_name AS name, users.email, users.status,
      roles.code AS role_id, MAX(sessions.created_at) AS last_activity,
      MAX(CASE WHEN sessions.expires_at > ? THEN 1 ELSE 0 END) AS online
    FROM users JOIN memberships ON memberships.user_id = users.id AND memberships.organization_id = ? AND memberships.status = 'active'
    JOIN roles ON roles.id = memberships.role_id
    LEFT JOIN sessions ON sessions.user_id = users.id
    GROUP BY users.id ORDER BY users.display_name`).bind(new Date().toISOString(), organizationId).all<{
      id: string; name: string; email: string; status: string; role_id: SystemRoleId | null; last_activity: string | null; online: number;
    }>();
  return result.results.map((row) => {
    const status: SystemUserStatus = row.status === "blocked" ? "blocked" : row.online ? "active" : "offline";
    return { id: row.id, initials: initials(row.name), name: row.name, email: row.email, roleId: row.role_id, status, statusLabel: status === "blocked" ? "Заблокирован" : status === "active" ? "Активен" : "Не в сети", activity: formatActivity(row.last_activity) };
  });
}

export async function listRoles(database: D1Database, organizationId: string): Promise<SystemRole[]> {
  const roles = await database.prepare("SELECT id, code, name, description FROM roles WHERE organization_id = ? ORDER BY CASE code WHEN 'dispatcher' THEN 1 WHEN 'executor' THEN 2 ELSE 3 END").bind(organizationId).all<{ id: string; code: SystemRoleId; name: string; description: string }>();
  const permissionRows = await database.prepare(`SELECT role_permissions.role_id, role_permissions.permission_code
    FROM role_permissions JOIN roles ON roles.id = role_permissions.role_id WHERE roles.organization_id = ?`).bind(organizationId).all<{ role_id: string; permission_code: SystemRole["permissions"][number] }>();
  const icons: Record<SystemRoleId, string> = { dispatcher: "support_agent", executor: "engineering", administrator: "admin_panel_settings" };
  return roles.results.map((role) => ({ id: role.code, name: role.name, description: role.description, icon: icons[role.code], permissions: permissionRows.results.filter((item) => item.role_id === role.id).map((item) => item.permission_code) }));
}

export async function listWorkTypes(database: D1Database): Promise<WorkTypeRecord[]> {
  const versions = await database.prepare(`SELECT work_types.id, work_types.name, work_types.description,
      work_type_versions.id AS version_id, work_type_versions.planned_duration_minutes, work_type_versions.is_emergency,
      work_type_versions.auto_accept_report, work_type_versions.verification_mode, work_type_versions.ai_verifier_connection_id, work_type_versions.report_template_json, work_type_versions.evidence_policy_json
    FROM work_types JOIN work_type_versions ON work_type_versions.id = (
      SELECT latest.id FROM work_type_versions AS latest WHERE latest.work_type_id = work_types.id ORDER BY latest.version DESC LIMIT 1
    ) WHERE work_types.active = 1 ORDER BY work_types.name`).all<{
      id: string; name: string; description: string; version_id: string; planned_duration_minutes: number; is_emergency: number; auto_accept_report: number; verification_mode: string; ai_verifier_connection_id: VerificationMethodId | null;
      report_template_json: string; evidence_policy_json: string;
    }>();
  const ids = versions.results.map((item) => item.version_id);
  if (!ids.length) return [];
  const placeholders = ids.map(() => "?").join(",");
  const skills = await database.prepare(`SELECT work_type_version_skills.work_type_version_id, skills.id, skills.name
    FROM work_type_version_skills JOIN skills ON skills.id = work_type_version_skills.skill_id
    WHERE work_type_version_skills.work_type_version_id IN (${placeholders}) ORDER BY skills.name`).bind(...ids).all<{ work_type_version_id: string; id: string; name: string }>();
  const qualifications = await database.prepare(`SELECT work_type_version_qualifications.work_type_version_id, qualifications.id, qualifications.name
    FROM work_type_version_qualifications JOIN qualifications ON qualifications.id = work_type_version_qualifications.qualification_id
    WHERE work_type_version_qualifications.work_type_version_id IN (${placeholders}) ORDER BY qualifications.name`).bind(...ids).all<{ work_type_version_id: string; id: string; name: string }>();
  const catalog = await loadWorkTypeCatalogMetadata(database);
  return versions.results.map((item) => ({
    reportTemplate: parseReportTemplate(JSON.parse(item.report_template_json)) ?? undefined,
    evidencePolicy: parseEvidencePolicy(JSON.parse(item.evidence_policy_json)) ?? undefined,
    isEmergency: Boolean(item.is_emergency), versionId: item.version_id, categoryIds: catalog.categoryIds(item.id), equipment: catalog.equipment(item.version_id),
    equipmentRequirements: catalog.equipment(item.version_id).map(({ equipmentId, quantity }) => ({ equipmentId, quantity })),
    id: item.id, name: item.name, description: item.description,
    plannedDurationMinutes: item.planned_duration_minutes,
    verificationMethodId: item.auto_accept_report ? "automatic" : item.verification_mode === "dispatcher" ? "dispatcher" : item.ai_verifier_connection_id ?? "route-vision-v1",
    requiredSkills: skills.results.filter((skill) => skill.work_type_version_id === item.version_id).map((skill) => skill.name),
    requiredSkillIds: skills.results.filter((skill) => skill.work_type_version_id === item.version_id).map((skill) => skill.id),
    requiredQualifications: qualifications.results.filter((qualification) => qualification.work_type_version_id === item.version_id).map((qualification) => qualification.name),
    requiredQualificationIds: qualifications.results.filter((qualification) => qualification.work_type_version_id === item.version_id).map((qualification) => qualification.id),
  }));
}

export async function listWorkSchedules(database: D1Database, organizationId: string, includeInactive = true): Promise<WorkScheduleRecord[]> {
  const schedules = await database.prepare(`SELECT id, name, active FROM work_schedules
    WHERE organization_id = ? ${includeInactive ? "" : "AND active = 1"} ORDER BY active DESC, name`)
    .bind(organizationId).all<{ id: string; name: string; active: number }>();
  if (!schedules.results.length) return [];
  const ids = schedules.results.map((schedule) => schedule.id);
  const placeholders = ids.map(() => "?").join(",");
  const days = await database.prepare(`SELECT schedule_id, weekday, enabled, start_time, end_time, break_start, break_end
    FROM work_schedule_days WHERE schedule_id IN (${placeholders}) ORDER BY weekday`).bind(...ids).all<{
      schedule_id: string; weekday: number; enabled: number; start_time: string | null; end_time: string | null;
      break_start: string | null; break_end: string | null;
    }>();
  return schedules.results.map((schedule) => ({
    id: schedule.id,
    name: schedule.name,
    active: Boolean(schedule.active),
    days: days.results.filter((day) => day.schedule_id === schedule.id).map((day) => ({
      weekday: day.weekday,
      enabled: Boolean(day.enabled),
      startTime: day.start_time ?? "",
      endTime: day.end_time ?? "",
      breakStart: day.break_start ?? "",
      breakEnd: day.break_end ?? "",
    })),
  }));
}

function initials(name: string) { return name.trim().split(/\s+/u).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join("") || "П"; }
function formatActivity(value: string | null) {
  if (!value) return "Ещё не входил";
  return new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Moscow" }).format(new Date(value)).replace(".", "");
}
