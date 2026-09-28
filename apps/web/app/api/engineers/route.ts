import { WORKER_TRANSPORT_SQL, WORKER_PLATE_SQL } from "@/app/lib/server/planning/worker-travel-policy";
import { listWorkerVehicles, workerVehicleStatements } from "@/app/lib/server/worker-vehicles";
import { NextResponse } from "next/server";
import type { EngineerRecord, ShiftStatus, TransportType } from "@/app/engineers/engineer-editor";
import { badRequest, conflict, isApiError, readJsonObject, requireApiContext, serverError } from "@/app/api/_shared";
import { listWorkSchedules, listWorkTypes } from "@/app/api/admin/_data";
import { isQualificationIds } from "@/app/admin/qualification-data";
import { listQualifications, resolveQualificationIds, updateWorkerQualifications, workerQualificationIds } from "@/app/lib/server/qualifications";
import { isSkillIds } from "@/app/admin/skill-data";
import { listSkills, resolveSkillIds, updateWorkerSkills, workerSkillIds } from "@/app/lib/server/skills";
import { isRegionalTimezone } from "@/app/lib/regional-time";

import { isWorkCompetencies, isUniqueIds } from "@/app/lib/work-catalog";
import { WorkCatalogError, listWorkCategories, listWorkerCompetencies, validateCompetencies, workerCompetencyStatements } from "@/app/lib/server/work-catalog";

export const dynamic = "force-dynamic";

type EngineerRow = {
  timezone: string | null; department_timezone: string;
  employee_number:string;
  id: string; name: string; phone: string; user_id: string | null; status: ShiftStatus; load_percent: number;
  transport_mode: TransportType; transport_details: string; warning: number; section: string | null;
  skill: string | null; clearance: string | null;
  work_schedule_id: string | null; work_schedule_name: string | null; start_address: string; start_latitude: number | null; start_longitude: number | null;
};

export async function GET(request: Request) {
  try {
    const context = await requireApiContext(request, "engineers.manage");
    if (isApiError(context)) return context;
    const [items, schedules, qualifications, skills] = await Promise.all([listEngineers(context.database, context.organizationId), listWorkSchedules(context.database, context.organizationId, false), listQualifications(context.database), listSkills(context.database)]);
    const users = await context.database.prepare(`SELECT users.id, users.display_name AS name, users.email
      FROM users JOIN memberships ON memberships.user_id = users.id
      JOIN roles ON roles.id = memberships.role_id
      WHERE memberships.organization_id = ? AND memberships.status = 'active' AND roles.code = 'executor'
      ORDER BY users.display_name`).bind(context.organizationId).all<{ id: string; name: string; email: string }>();
    const [workCategories, workTypes] = await Promise.all([listWorkCategories(context.database), listWorkTypes(context.database)]);
    return NextResponse.json({ items, users: users.results, schedules, qualifications, skills, workCategories, workTypes, vehicles: await listWorkerVehicles(context.database,context.organizationId) });
  } catch (error) { if (String(error).includes("resource_must_be_available")) return conflict("Автомобиль уже занят. Обновите список и выберите другой."); return error instanceof WorkCatalogError ? NextResponse.json({ message: error.message }, { status: error.status }) : serverError(error); }
}

export async function POST(request: Request) {
  try {
    const context = await requireApiContext(request, "engineers.manage");
    if (isApiError(context)) return context;
    const payload = parsePayload(await readJsonObject(request));
    if (!payload) return badRequest();
    if (await userHasOtherWorker(context.database, payload.userId)) return conflict("Этот пользователь уже связан с другим исполнителем.");
    const id = crypto.randomUUID();
    const references = await resolveReferences(context.database, context.organizationId, payload);
    if (!references) return badRequest("Проверьте компетенции ВК–HD и рабочий график.");
    const now = new Date().toISOString();
    const vehicleStatements = await workerVehicleStatements(context.database,context.organizationId,id,payload.resourceId,now);
    await context.database.batch([
      context.database.prepare(`INSERT INTO workers
        (id, organization_id, user_id, service_area_id, work_schedule_id, employee_number, full_name, phone, start_address, start_latitude, start_longitude, shift_status, load_percent,
          transport_mode, travel_mode, transport_details, qualification_warning, timezone, active, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, (SELECT CAST(COALESCE(MAX(CAST(employee_number AS INTEGER)),0)+1 AS TEXT) FROM workers WHERE employee_number<>'' AND employee_number NOT GLOB '*[^0-9]*'), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`).bind(id, context.organizationId, payload.userId || null, references.areaId, references.scheduleId, payload.name, payload.phone, payload.startAddress, payload.startPoint?.lat ?? null, payload.startPoint?.lon ?? null, payload.status, payload.load, payload.transportType, payload.transportType,payload.transport, payload.warning ? 1 : 0, payload.timezone || null, now, now),
      ...saveWorkerSkills(context.database, id, references.skillIds, now),
      ...saveWorkerQualifications(context.database, id, references.qualificationIds, payload.warning),
      ...workerCompetencyStatements(context.database, id, payload.workCompetencies ?? []),
      ...vehicleStatements,
    ]);
    const items = await listEngineers(context.database, context.organizationId);
    return NextResponse.json({ item: items.find((item) => item.id === id), vehicles: await listWorkerVehicles(context.database,context.organizationId) }, { status: 201 });
  } catch (error) { if (String(error).includes("resource_must_be_available")) return conflict("Автомобиль уже занят. Обновите список и выберите другой."); return error instanceof WorkCatalogError ? NextResponse.json({ message: error.message }, { status: error.status }) : serverError(error); }
}

export async function PUT(request: Request) {
  try {
    const context = await requireApiContext(request, "engineers.manage");
    if (isApiError(context)) return context;
    const body = await readJsonObject(request);
    const payload = parsePayload(body);
    if (!payload || typeof body?.id !== "string") return badRequest();
    const exists = await context.database.prepare("SELECT id FROM workers WHERE id = ? AND organization_id = ?").bind(body.id, context.organizationId).first();
    if (!exists) return NextResponse.json({ message: "Исполнитель не найден." }, { status: 404 });
    if (await userHasOtherWorker(context.database, payload.userId, body.id)) return conflict("Этот пользователь уже связан с другим исполнителем.");
    const retainedIds = await workerQualificationIds(context.database, body.id);
    const retainedSkillIds = await workerSkillIds(context.database, body.id);
    const references = await resolveReferences(context.database, context.organizationId, payload, retainedIds, retainedSkillIds);
    if (!references) return badRequest("Проверьте компетенции ВК–HD и рабочий график.");
    const now = new Date().toISOString();
    const vehicleStatements = await workerVehicleStatements(context.database,context.organizationId,body.id,payload.resourceId,now);
    await context.database.batch([
      context.database.prepare(`UPDATE workers SET user_id = ?, service_area_id = ?, work_schedule_id = ?, full_name = ?, phone = ?, start_address = ?, start_latitude = ?, start_longitude = ?, shift_status = ?,
        load_percent = ?, transport_mode = ?, travel_mode = ?, transport_details = ?, qualification_warning = ?, timezone = CASE WHEN ? THEN ? ELSE timezone END, updated_at = ?
        WHERE id = ? AND organization_id = ?`).bind(payload.userId || null, references.areaId, references.scheduleId, payload.name, payload.phone, payload.startAddress, payload.startPoint?.lat ?? null, payload.startPoint?.lon ?? null, payload.status, payload.load, payload.transportType,payload.transportType, payload.transport, payload.warning ? 1 : 0, payload.timezone !== undefined ? 1 : 0, payload.timezone || null, now, body.id, context.organizationId),
      ...saveWorkerSkills(context.database, body.id, payload.skillIds ? references.skillIds : [...new Set([...retainedSkillIds, ...references.skillIds])], now),
      ...saveWorkerQualifications(context.database, body.id, payload.qualificationIds ? references.qualificationIds : [...new Set([...retainedIds, ...references.qualificationIds])], payload.warning),
      ...(payload.workCompetencies === undefined ? [] : workerCompetencyStatements(context.database, body.id, payload.workCompetencies)),
      ...vehicleStatements,
    ]);
    const items = await listEngineers(context.database, context.organizationId);
    return NextResponse.json({ item: items.find((item) => item.id === body.id), vehicles: await listWorkerVehicles(context.database,context.organizationId) });
  } catch (error) { if (String(error).includes("resource_must_be_available")) return conflict("Автомобиль уже занят. Обновите список и выберите другой."); return error instanceof WorkCatalogError ? NextResponse.json({ message: error.message }, { status: error.status }) : serverError(error); }
}

async function listEngineers(database: D1Database, organizationId: string): Promise<EngineerRecord[]> {
  const result = await database.prepare(`SELECT workers.id, workers.employee_number, workers.full_name AS name, workers.phone, workers.user_id,
      workers.timezone, organizations.timezone AS department_timezone,
      workers.shift_status AS status, workers.load_percent, ${WORKER_TRANSPORT_SQL} AS transport_mode, ${WORKER_PLATE_SQL} AS transport_details,
      workers.work_schedule_id, work_schedules.name AS work_schedule_name, workers.start_address, workers.start_latitude, workers.start_longitude,
      workers.qualification_warning AS warning, service_areas.name AS section,
      (SELECT skills.name FROM worker_skills JOIN skills ON skills.id = worker_skills.skill_id WHERE worker_skills.worker_id = workers.id LIMIT 1) AS skill,
      (SELECT qualifications.name FROM worker_qualifications JOIN qualifications ON qualifications.id = worker_qualifications.qualification_id WHERE worker_qualifications.worker_id = workers.id LIMIT 1) AS clearance
    FROM workers JOIN organizations ON organizations.id = workers.organization_id
    LEFT JOIN service_areas ON service_areas.id = workers.service_area_id
    LEFT JOIN work_schedules ON work_schedules.id = workers.work_schedule_id
    WHERE workers.organization_id = ? AND workers.active = 1 ORDER BY workers.full_name`).bind(organizationId).all<EngineerRow>();
  const qualifications = await database.prepare(`SELECT wq.worker_id, q.id, q.name FROM worker_qualifications wq
    JOIN workers w ON w.id = wq.worker_id JOIN qualifications q ON q.id = wq.qualification_id
    WHERE w.organization_id = ? ORDER BY q.name, q.id`).bind(organizationId)
    .all<{ worker_id: string; id: string; name: string }>();
  const skills = await database.prepare(`SELECT ws.worker_id, s.id, s.name FROM worker_skills ws
    JOIN workers w ON w.id = ws.worker_id JOIN skills s ON s.id = ws.skill_id
    WHERE w.organization_id = ? ORDER BY s.name, s.id`).bind(organizationId)
    .all<{ worker_id: string; id: string; name: string }>();
  const vehicles = await listWorkerVehicles(database,organizationId);
  const competencies = await listWorkerCompetencies(database, organizationId);
  return result.results.map((row) => ({
    employeeNumber: row.employee_number, resourceId: vehicles.find(v=>v.assignedWorkerId===row.id)?.id ?? "",
    workCompetencies: competencies.get(row.id) ?? [],
    timezone: row.timezone ?? "", effectiveTimezone: row.timezone ?? row.department_timezone,
    id: row.id, initials: initials(row.name), name: row.name, phone: row.phone, userId: row.user_id ?? "",
    status: row.status, skill: row.skill ?? "", clearance: row.clearance ?? "", load: row.load_percent,
    qualificationIds: qualifications.results.filter((item) => item.worker_id === row.id).map((item) => item.id),
    qualificationNames: qualifications.results.filter((item) => item.worker_id === row.id).map((item) => item.name),
    skillIds: skills.results.filter((item) => item.worker_id === row.id).map((item) => item.id),
    skillNames: skills.results.filter((item) => item.worker_id === row.id).map((item) => item.name),
    transportType: row.transport_mode, transport: row.transport_mode === 'car' ? row.transport_details || 'Автомобиль' : 'Общественный транспорт + пешком',
    section: row.section ?? "", warning: Boolean(row.warning),
    workScheduleId: row.work_schedule_id ?? "", workScheduleName: row.work_schedule_name ?? "Без графика", startAddress: row.start_address,
    startPoint: row.start_latitude !== null && row.start_longitude !== null ? { lat: row.start_latitude, lon: row.start_longitude } : null,
  }));
}

function parsePayload(body: Record<string, unknown> | null): EngineerRecord | null {
  const hd = Boolean(body && isWorkCompetencies(body.workCompetencies));
  if (!body || !isText(body.name) || !isOptionalText(body.phone) || !isOptionalText(body.userId) || (hd ? typeof body.skill !== "string" : !isText(body.skill)) || (hd ? typeof body.clearance !== "string" : !isText(body.clearance)) || !isOptionalText(body.section) || !isText(body.workScheduleId) || typeof body.startAddress !== "string" || body.startAddress.length > 500) return null;
  if (!isShiftStatus(body.status) || !isTransportType(body.transportType) || typeof body.load !== "number" || body.load < 0 || body.load > 100 || typeof body.warning !== "boolean") return null;
  if (body.startAddress.trim() ? !isPoint(body.startPoint) : body.startPoint !== null) return null;
  if (body.timezone !== undefined && body.timezone !== "" && !isRegionalTimezone(body.timezone)) return null;
  if (body.workCompetencies !== undefined && !isWorkCompetencies(body.workCompetencies)) return null;
  if (body.qualificationIds !== undefined && !(hd ? isUniqueIds(body.qualificationIds) : isQualificationIds(body.qualificationIds))) return null;
  if (body.skillIds !== undefined && !(hd ? isUniqueIds(body.skillIds) : isSkillIds(body.skillIds))) return null;
  if (body.resourceId !== undefined && (typeof body.resourceId !== "string" || body.resourceId.length>150)) return null;
  const transport = typeof body.transport === "string" ? body.transport.trim() : "";
  if (body.transport !== undefined && !isOptionalText(body.transport)) return null;
  return { id: typeof body.id === "string" ? body.id : "", initials: initials(body.name), name: body.name.trim(), phone: body.phone.trim(), userId: body.userId, status: body.status, skill: body.skill as string, clearance: body.clearance as string, load: body.load, transportType: body.transportType, transport, section: body.section, warning: body.warning, workScheduleId: body.workScheduleId, workScheduleName: typeof body.workScheduleName === "string" ? body.workScheduleName : "", startAddress: body.startAddress.trim(), startPoint: body.startPoint as EngineerRecord["startPoint"],
    ...(body.resourceId !== undefined ? {resourceId:body.resourceId as string} : {}),
    ...(body.workCompetencies !== undefined ? { workCompetencies: body.workCompetencies as EngineerRecord["workCompetencies"] } : {}),
    ...(body.timezone !== undefined ? { timezone: body.timezone as string } : {}),
    ...(body.qualificationIds !== undefined ? { qualificationIds: body.qualificationIds as string[] } : {}),
    ...(body.skillIds !== undefined ? { skillIds: body.skillIds as string[] } : {}) };
}

async function resolveReferences(database: D1Database, organizationId: string, payload: EngineerRecord, retainedIds: string[] = [], retainedSkillIds: string[] = []) {
  if (payload.workCompetencies !== undefined) await validateCompetencies(database, organizationId, payload.workCompetencies);
  if (payload.userId && !await database.prepare("SELECT 1 FROM memberships WHERE user_id=? AND organization_id=? AND status='active'").bind(payload.userId, organizationId).first()) return null;
  const hd = payload.workCompetencies !== undefined;
  const [area, skillIds, qualificationIds, schedule] = await Promise.all([
    database.prepare("SELECT id FROM service_areas WHERE organization_id = ? AND name = ? AND active = 1 LIMIT 1").bind(organizationId, payload.section).first<{ id: string }>(),
    hd && payload.skillIds?.length === 0 ? Promise.resolve([]) : resolveSkillIds(database, organizationId, { ...(payload.skillIds ? { ids: payload.skillIds } : {}), names: [payload.skill] }, retainedSkillIds),
    hd && payload.qualificationIds?.length === 0 ? Promise.resolve([]) : resolveQualificationIds(database, organizationId, { ...(payload.qualificationIds ? { ids: payload.qualificationIds } : {}), names: [payload.clearance] }, retainedIds),
    database.prepare("SELECT id FROM work_schedules WHERE organization_id = ? AND id = ? AND active = 1 LIMIT 1").bind(organizationId, payload.workScheduleId).first<{ id: string }>(),
  ]);
  return (!payload.section || area) && skillIds && qualificationIds && schedule ? { areaId: area?.id ?? null, skillIds, qualificationIds, scheduleId: schedule.id } : null;
}

async function userHasOtherWorker(database: D1Database, userId: string, excludedId = "") {
  if (!userId) return false;
  return Boolean(await database.prepare("SELECT id FROM workers WHERE user_id = ? AND id <> ? LIMIT 1").bind(userId, excludedId).first());
}
function isText(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0 && value.length <= 500; }
function isOptionalText(value: unknown): value is string { return typeof value === "string" && value.length <= 500; }
function isShiftStatus(value: unknown): value is ShiftStatus { return value === "on_shift" || value === "break" || value === "off_shift"; }
function isTransportType(value: unknown): value is TransportType { return value === "car" || value === "transit"; }
function isPoint(value: unknown): value is { lat: number; lon: number } {
  if (!value || typeof value !== "object") return false;
  const point = value as Record<string, unknown>;
  return typeof point.lat === "number" && Number.isFinite(point.lat) && point.lat >= -90 && point.lat <= 90
    && typeof point.lon === "number" && Number.isFinite(point.lon) && point.lon >= -180 && point.lon <= 180;
}
function initials(name: string) { return name.trim().split(/\s+/u).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join("") || "И"; }

function saveWorkerSkills(db: D1Database, id: string, ids: string[], now: string) {
  return ids.length ? updateWorkerSkills(db, id, ids, now) : [db.prepare("DELETE FROM worker_skills WHERE worker_id=?").bind(id)];
}
function saveWorkerQualifications(db: D1Database, id: string, ids: string[], warning: boolean) {
  return ids.length ? updateWorkerQualifications(db, id, ids, warning) : [db.prepare("DELETE FROM worker_qualifications WHERE worker_id=?").bind(id)];
}
