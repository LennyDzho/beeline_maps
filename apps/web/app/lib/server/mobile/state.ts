import type { MobileContext } from "./context";
import { MobileError } from "./errors";

import { instantToRegionalTime, scheduleTimeToInstant } from "../../regional-time";
import { emergencyWindow } from "../../request-scheduling";
import { loadReportRequirements, readReportSections } from "../../report-requirements";

export const datasetVersionSql = "COALESCE((SELECT version FROM application_dataset WHERE id=1), 'legacy')";
export async function mobileDatasetVersion(database: D1Database) {
  return (await database.prepare(`SELECT ${datasetVersionSql} AS version`).first<{ version: string }>())!.version;
}
export async function assertMobileDataset(database: D1Database, supplied: unknown) {
  const current = await mobileDatasetVersion(database);
  if (current !== (supplied ?? "legacy")) throw new MobileError(409, "Набор заявок обновлён. Обновите мобильное приложение и расписание: старые действия не приняты.", "dataset_changed");
  return current;
}

export type MobileOrder = { is_emergency: number; scheduling_timezone: string; apartment: string; entrance: string; intercom: string; id: string; number: string; title: string; address: string; notes: string; description: string;
  category_name: string | null; client_window_start: string | null; client_window_end: string | null;
  scheduled_start: string; scheduled_end: string | null; planned_duration_minutes: number; priority: string; status: string;
  revision: number; latitude: number | null; longitude: number | null; report_id: string | null; comment: string | null; report_status: string | null; field_values_json: string | null; };
export async function ownOrder(ctx: MobileContext, id: string) {
  const row = await ctx.database.prepare(`SELECT id, status, revision FROM work_orders WHERE id = ? AND assignee_worker_id = ? AND organization_id = ?`)
    .bind(id, ctx.workerId, ctx.organizationId).first<{ id: string; status: string; revision: number }>();
  if (!row) throw new MobileError(404, "Заявка недоступна.");
  return row;
}
export async function mobileState(ctx: MobileContext, requestedDate: string | null) {
  const datasetVersion = await mobileDatasetVersion(ctx.database);
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: ctx.timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const date = requestedDate ?? today;
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(date) || Number.isNaN(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date) throw new MobileError(400, "Некорректная дата.");
  const lower = new Date(Date.parse(`${date}T00:00:00Z`) - 2 * 86400000).toISOString().slice(0, 10);
  const upper = new Date(Date.parse(`${date}T00:00:00Z`) + 2 * 86400000).toISOString().slice(0, 10);
  const [orders, dates, history, issues, skills, equipment, components, scheduling] = await Promise.all([
    ctx.database.prepare(`SELECT o.id, o.number, COALESCE((SELECT GROUP_CONCAT(name_snapshot, ' + ') FROM (SELECT name_snapshot FROM work_order_work_types WHERE work_order_id=o.id ORDER BY sequence)), t.name) AS title, o.address_snapshot AS address, COALESCE(s.notes, '') AS notes,
      COALESCE(o.scheduling_timezone,org.timezone) AS scheduling_timezone, o.apartment, o.entrance, o.intercom, o.description, o.scheduled_start, o.scheduled_end, COALESCE(o.service_duration_minutes, v.planned_duration_minutes) AS planned_duration_minutes, o.priority, o.status, o.revision,
      o.latitude_snapshot AS latitude, o.longitude_snapshot AS longitude, r.id AS report_id, r.comment, r.status AS report_status, r.field_values_json,
      c.name AS category_name, o.client_window_start, o.client_window_end,
      (v.is_emergency=1 OR EXISTS(SELECT 1 FROM work_order_work_types ew JOIN work_type_versions ev ON ev.id=ew.work_type_version_id WHERE ew.work_order_id=o.id AND ev.is_emergency=1)) AS is_emergency
      FROM work_orders o JOIN organizations org ON org.id=o.organization_id JOIN work_type_versions v ON v.id = o.work_type_version_id JOIN work_types t ON t.id = v.work_type_id
      LEFT JOIN service_objects s ON s.id = o.service_object_id
      LEFT JOIN work_categories c ON c.id=o.category_id
      LEFT JOIN work_reports r ON r.id = (SELECT id FROM work_reports WHERE work_order_id = o.id ORDER BY revision DESC LIMIT 1)
      WHERE o.assignee_worker_id = ? AND o.organization_id = ? AND o.status <> 'cancelled'
        AND (SUBSTR(o.scheduled_start, 1, 10) BETWEEN ? AND ? OR o.status IN ('en_route', 'in_progress', 'paused'))
      ORDER BY CASE WHEN o.status = 'paused' THEN 1 ELSE 0 END, o.scheduled_start`).bind(ctx.workerId, ctx.organizationId, lower, upper).all<MobileOrder>(),
    ctx.database.prepare(`SELECT DISTINCT scheduled_start, COALESCE(scheduling_timezone,org.timezone) AS timezone FROM work_orders o JOIN organizations org ON org.id=o.organization_id
      WHERE assignee_worker_id = ? AND organization_id = ? AND o.status <> 'cancelled' ORDER BY scheduled_start DESC`).bind(ctx.workerId, ctx.organizationId).all<{ scheduled_start: string; timezone: string }>(),
    ctx.database.prepare(`SELECT h.id, h.work_order_id, h.to_status, h.reason, h.created_at, n.event_id AS read_id
      FROM work_order_status_history h JOIN work_orders o ON o.id = h.work_order_id
      LEFT JOIN mobile_notice_reads n ON n.user_id = ? AND n.event_id = h.id
      WHERE o.assignee_worker_id = ? AND o.organization_id = ? ORDER BY h.created_at DESC LIMIT 150`).bind(ctx.user.id, ctx.workerId, ctx.organizationId)
      .all<{ id: string; work_order_id: string; to_status: string; reason: string | null; created_at: string; read_id: string | null }>(),
    ctx.database.prepare(`SELECT i.* FROM mobile_issues i JOIN work_orders o ON o.id = i.work_order_id
      WHERE o.assignee_worker_id = ? AND o.organization_id = ? ORDER BY i.created_at DESC LIMIT 100`).bind(ctx.workerId, ctx.organizationId)
      .all<{ id: string; work_order_id: string; reason: string; detail: string; created_at: string }>(),
    ctx.database.prepare(`SELECT s.name FROM worker_skills ws JOIN skills s ON s.id=ws.skill_id WHERE ws.worker_id=?
      UNION SELECT c.name || ' → ' || t.name AS name FROM worker_work_competencies wc
      JOIN work_categories c ON c.id=wc.category_id JOIN work_types t ON t.id=wc.work_type_id
      WHERE wc.worker_id=? ORDER BY name`).bind(ctx.workerId, ctx.workerId).all<{ name: string }>(),
    ctx.database.prepare(`SELECT e.* FROM work_order_equipment e JOIN work_orders o ON o.id=e.work_order_id
      WHERE o.assignee_worker_id=? AND o.organization_id=? ORDER BY e.name_snapshot,e.equipment_id`).bind(ctx.workerId, ctx.organizationId)
      .all<{ work_order_id: string; equipment_id: string; name_snapshot: string; unit_snapshot: string; usage_snapshot: string; quantity: number | null }>(),
    ctx.database.prepare(`SELECT w.* FROM work_order_work_types w JOIN work_orders o ON o.id=w.work_order_id
      WHERE o.assignee_worker_id=? AND o.organization_id=? ORDER BY w.sequence`).bind(ctx.workerId, ctx.organizationId)
      .all<{ work_order_id: string; work_type_version_id: string; name_snapshot: string }>(),
    ctx.database.prepare(`SELECT a.id,a.entity_id,a.payload_json,a.created_at FROM audit_events a JOIN work_orders o ON o.id=a.entity_id
      WHERE a.organization_id=? AND o.organization_id=? AND o.assignee_worker_id=?
        AND a.entity_type='work_order' AND a.action='scheduling_changed' ORDER BY a.created_at DESC,a.rowid DESC LIMIT 150`)
      .bind(ctx.organizationId, ctx.organizationId, ctx.workerId).all<{ id: string; entity_id: string; payload_json: string; created_at: string }>(),
  ]);
  for(const order of orders.results) if(order.is_emergency) {
    const window=emergencyWindow(order.scheduled_start,order.scheduling_timezone);
    order.client_window_start=window.windowStart;order.client_window_end=window.windowEnd;order.priority="high";
  }
  const regionalOrders = orders.results.map(order => ({ ...order,
    scheduled_start: instantToRegionalTime(scheduleTimeToInstant(order.scheduled_start, order.scheduling_timezone), ctx.timezone).slice(0, 16),
    scheduled_end: order.scheduled_end ? instantToRegionalTime(scheduleTimeToInstant(order.scheduled_end, order.scheduling_timezone), ctx.timezone).slice(0, 16) : null,
  })).filter(order => order.scheduled_start.slice(0, 10) === date || ["en_route", "in_progress", "paused"].includes(order.status));
  regionalOrders.sort((a,b) => Number(a.status === "paused") - Number(b.status === "paused") || a.scheduled_start.localeCompare(b.scheduled_start));
  const reportRequirements=await loadReportRequirements(ctx.database,ctx.organizationId,regionalOrders.map(order=>order.id));
  const availableDates = [...new Set(dates.results.map(row => instantToRegionalTime(scheduleTimeToInstant(row.scheduled_start, row.timezone), ctx.timezone).slice(0, 10)))].sort().reverse();
  const media = await ctx.database.prepare(`SELECT m.id, m.report_id, m.kind, m.file_name, m.mime_type, m.size_bytes, m.captured_at
    FROM report_media m JOIN work_reports r ON r.id = m.report_id JOIN work_orders o ON o.id = r.work_order_id
    WHERE o.assignee_worker_id = ? AND o.organization_id = ? AND m.upload_status = 'uploaded' AND m.storage_key NOT LIKE 'demo/%'
    ORDER BY m.created_at LIMIT 1000`).bind(ctx.workerId, ctx.organizationId)
    .all<{ id: string; report_id: string; kind: string; file_name: string; mime_type: string; size_bytes: number; captured_at: string | null }>();
  const offset = new Intl.DateTimeFormat("en", { timeZone: ctx.timezone, timeZoneName: "shortOffset" }).formatToParts(new Date()).find(part => part.type === "timeZoneName")?.value ?? ctx.timezone;
  await assertMobileDataset(ctx.database, datasetVersion);
  return { protocol: 1, datasetVersion, serverTime: new Date().toISOString(), serviceDate: date, today, availableDates, timezone: ctx.timezone,
    profile: { id: ctx.user.id, workerId: ctx.workerId, name: ctx.workerName, email: ctx.user.email, organization: ctx.organizationName, timezone: ctx.timezone, timezoneLabel: `${ctx.timezone} · ${offset}`, skills: skills.results.map(s => s.name) }, onShift: ctx.onShift,
    visits: regionalOrders.map(o => ({ id: o.id, number: o.number, title: o.title, address: o.address, entrance: [o.apartment && `Квартира / офис: ${o.apartment}`, o.entrance && `Подъезд: ${o.entrance}`, o.intercom && `Домофон: ${o.intercom}`, o.notes].filter(Boolean).join(" · "), description: o.description,
      scheduledStart: o.scheduled_start, scheduledEnd: o.scheduled_end, durationMinutes: o.planned_duration_minutes, highPriority: o.priority === "high", isEmergency:Boolean(o.is_emergency),
      categoryName: o.category_name ?? "",
      clientWindowStart: o.client_window_start ? instantToRegionalTime(scheduleTimeToInstant(o.client_window_start, o.scheduling_timezone), ctx.timezone).slice(0, 16) : null,
      clientWindowEnd: o.client_window_end ? instantToRegionalTime(scheduleTimeToInstant(o.client_window_end, o.scheduling_timezone), ctx.timezone).slice(0, 16) : null,
      workTypes: components.results.filter(w => w.work_order_id === o.id).map(w => ({ versionId: w.work_type_version_id, name: w.name_snapshot })),
      equipment: equipment.results.filter(e => e.work_order_id === o.id).map(e => ({ id: e.equipment_id, name: e.name_snapshot, unit: e.unit_snapshot, usage: e.usage_snapshot, quantity: e.quantity })),
      status: o.status, revision: o.revision, latitude: o.latitude, longitude: o.longitude, report: o.comment ?? "", reportStatus: o.report_status,
      reportRequirements:readReportSections(o.field_values_json ?? '{}').length ? readReportSections(o.field_values_json!).map(section=>({
        versionId:section.versionId,name:section.name,fields:section.fields,minPhotos:section.minPhotos,minVideos:section.minVideos,
        verificationMode:section.verificationMode,verifierId:section.verifierId,configurationError:section.configurationError,
      })) : reportRequirements.get(o.id) ?? [],
      reportValues:Object.fromEntries(readReportSections(o.field_values_json ?? '{}').map(section=>[section.versionId,section.values])),
      events: [
        ...history.results.filter(h => h.work_order_id === o.id).map(h => ({ createdAt: h.created_at, title: statusLabel(h.to_status), detail: `${formatTime(h.created_at, ctx.timezone)} · ${h.reason ?? "Изменение заявки"}` })),
        ...scheduling.results.filter(h => h.entity_id === o.id).map(h => {
          const change = JSON.parse(h.payload_json) as { source: string; reason: string; before?: { workerName: string; start: string; timezone: string } | null; after: { workerName: string; start: string; timezone: string } };
          const appointment = (item: NonNullable<typeof change.before>) => `${item.workerName || "Не назначена"}, ${formatTime(scheduleTimeToInstant(item.start, item.timezone), ctx.timezone)}`;
          return { createdAt: h.created_at, title: change.source === "manual" ? "Изменено диспетчером" : "План изменён", detail: `${formatTime(h.created_at, ctx.timezone)} · ${change.reason}${change.before ? ` ${appointment(change.before)} → ${appointment(change.after)}` : ""}` };
        }),
      ].sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
      problems: issues.results.filter(i => i.work_order_id === o.id).map(i => `${formatTime(i.created_at, ctx.timezone)} · ${i.reason}: ${i.detail}`),
      problemLog: issues.results.filter(i => i.work_order_id === o.id).map(i => ({ id: i.id, reason: i.reason, detail: i.detail, createdAt: i.created_at })),
      media: media.results.filter(m => m.report_id === o.report_id).map(m => ({ id: m.id, kind: m.kind, name: m.file_name, mimeType: m.mime_type, size: m.size_bytes, capturedAt: m.captured_at })) })),
    notices: history.results.map(h => ({ id: h.id, visitId: regionalOrders.some(o => o.id === h.work_order_id) ? h.work_order_id : null,
      title: `${h.work_order_id} · ${statusLabel(h.to_status)}`, text: h.reason ?? "Состояние заявки изменено", time: formatTime(h.created_at, ctx.timezone), read: Boolean(h.read_id) })) };
}
export function statusLabel(status: string) { return ({ new: "Новая", assigned: "Назначена", en_route: "В пути", in_progress: "В работе", paused: "Приостановлена", completed: "Завершена", confirmed: "Принята", cancelled: "Отменена" } as Record<string, string>)[status] ?? status; }
function formatTime(value: string, timeZone: string) { return new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", timeZone }).format(new Date(value)); }
