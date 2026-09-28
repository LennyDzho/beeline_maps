import { WORKER_TRANSPORT_SQL } from "@/app/lib/server/planning/worker-travel-policy";
import { NextResponse } from "next/server";
import type { CompletionMedia, RequestEngineer, RequestItem, RequestPriority, RequestStatus } from "@/app/requests/request-editor";
import { badRequest, conflict, isApiError, readJsonObject, requireApiContext, serverError } from "@/app/api/_shared";
import { listWorkTypes } from "@/app/api/admin/_data";
import { GeocodingError, geocodeAddress } from "@/app/lib/server/geocoding";
import { emergencyWindow, requestScheduling } from "@/app/lib/request-scheduling";
import { instantToRegionalTime } from "@/app/lib/regional-time";

import { isUniqueIds } from "@/app/lib/work-catalog";
import { WorkCatalogError, listWorkCategories, listWorkerCompetencies } from "@/app/lib/server/work-catalog";
import { loadOrderCompositions, resolveOrderComposition, orderCompositionStatements, eligibleCompositionWorker } from "@/app/lib/server/work-order-composition";

import { manualSchedulingReason, findServiceConflicts, type ScheduleSnapshot } from "@/app/lib/scheduling-changes";
import { loadSchedulingChanges, schedulingChangeStatement } from "@/app/lib/server/scheduling-changes";
import { departmentEquipment } from "@/app/lib/server/brigade-equipment";
import { equipmentWarning } from "@/app/lib/brigade-equipment";
import { readReportSections } from "@/app/lib/report-requirements";

export const dynamic = "force-dynamic";

type RequestRow = {
  client_visit_confirmed: number;
  scheduling_timezone: string; client_window_start: string | null; client_window_end: string | null;
  building_address: string; apartment: string; entrance: string; intercom: string;
  id: string;
  number: string;
  work_type_version_id: string;
  work: string;
  description: string;
  priority: RequestPriority;
  status: string;
  date_time: string;
  address: string;
  latitude: number | null;
  longitude: number | null;
  assignee: string | null;
  report_id: string | null;
  performer: string | null;
  submitted_at: string | null;
  report_comment: string | null;
  report_fields: string | null;
  revision: number;
  assignee_worker_id: string | null;
};

type RequestPayload = Omit<RequestItem, "completionReport" | "requiredSkills" | "requiredQualifications" | "point">;

export async function GET(request: Request) {
  try {
    const context = await requireApiContext(request, "requests.view");
    if (isApiError(context)) return context;
    const unrestricted = await context.database.prepare(`SELECT 1 FROM memberships m JOIN role_permissions p ON p.role_id = m.role_id
      WHERE m.organization_id = ? AND m.user_id = ? AND m.status = 'active' AND p.permission_code IN ('requests.manage', 'reports.view') LIMIT 1`).bind(context.organizationId, context.user.id).first();
    const worker = unrestricted ? null : await context.database.prepare("SELECT id FROM workers WHERE user_id = ? AND organization_id = ? AND active = 1").bind(context.user.id, context.organizationId).first<{ id: string }>();
    const items = await listRequests(context.database, context.organizationId, unrestricted ? undefined : worker?.id ?? "__no_worker__");
    const workTypes = unrestricted ? await listWorkTypes(context.database) : [];
    const engineers = unrestricted ? await listRequestEngineers(context.database, context.organizationId) : [];
    const department = await context.database.prepare("SELECT timezone FROM organizations WHERE id = ?").bind(context.organizationId).first<{ timezone: string }>();
    const workCategories = unrestricted ? await listWorkCategories(context.database) : [];
    return NextResponse.json({ items, workTypes, engineers, workCategories, departmentTimezone: department!.timezone });
  } catch (error) {
    return serverError(error);
  }
}

export async function POST(request: Request) {
  try {
    const context = await requireApiContext(request, "requests.manage");
    if (isApiError(context)) return context;
    const body = await readJsonObject(request);
    const payload = parsePayload(body);
    if (!payload) return badRequest();
    if (payload.status === "paused") return badRequest("Новую заявку нельзя создать приостановленной.");

    const id = crypto.randomUUID();
    const composition = await resolveOrderComposition(context.database, context.organizationId, payload);
    const isEmergency=composition.components.some(item=>item.isEmergency);
    if(isEmergency)payload.priority="high";
    const workTypeVersion = { id: composition.components[0].versionId, plannedDurationMinutes: composition.duration };
    const department = await context.database.prepare("SELECT timezone FROM organizations WHERE id = ?").bind(context.organizationId).first<{ timezone: string }>();
    const scheduling = requestScheduling(payload, payload.dateTime, workTypeVersion.plannedDurationMinutes, department!.timezone,undefined,isEmergency);
    const scheduledEnd = scheduling.scheduledEnd;
    const assigneeId = await eligibleCompositionWorker(context.database, context.organizationId, payload.assignee, composition, payload.assigneeId);
    if (payload.assignee && !assigneeId) return badRequest("Исполнитель не соответствует требованиям выбранного типа работ.");
    const geocoded = await geocodeAddress(payload.buildingAddress || payload.address);
    const now = new Date().toISOString();
    const objectId = `OBJECT-${id}`;
    const databaseStatus = toDatabaseStatus(payload.status);

    const after: ScheduleSnapshot = { workerId: assigneeId, workerName: payload.assignee, start: payload.dateTime, end: scheduledEnd, timezone: scheduling.timezone, windowStart: scheduling.windowStart, windowEnd: scheduling.windowEnd };
    const reason = manualSchedulingReason(null, after);
    await context.database.batch([
      context.database.prepare(`INSERT INTO service_objects
        (id, organization_id, external_reference, name, address, latitude, longitude, notes, active, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, '', 1, ?, ?)`).bind(objectId, context.organizationId, id, `Объект ${id}`, payload.address, geocoded.point.lat, geocoded.point.lon, now, now),
      context.database.prepare(`INSERT INTO work_orders
        (id, organization_id, number, work_type_version_id, service_object_id, assignee_worker_id, created_by_user_id,
          confirmed_by_user_id, description, priority, status, scheduled_start, scheduled_end, address_snapshot, latitude_snapshot, longitude_snapshot,
          confirmed_at, created_at, updated_at, scheduling_timezone, client_window_start, client_window_end, building_address, apartment, entrance, intercom, category_id, service_duration_minutes, duration_source, client_visit_confirmed)
        VALUES (?, ?, (SELECT CAST(COALESCE(MAX(CASE WHEN number <> '' AND number NOT GLOB '*[^0-9]*' THEN CAST(number AS INTEGER) END), 0) + 1 AS TEXT) FROM work_orders), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
          id, context.organizationId, workTypeVersion.id, objectId, assigneeId, context.user.id,
          databaseStatus === "confirmed" ? context.user.id : null, payload.description, payload.priority, databaseStatus,
          payload.dateTime, scheduledEnd, payload.address, geocoded.point.lat, geocoded.point.lon,
          databaseStatus === "confirmed" ? now : null, now, now,
          scheduling.timezone, scheduling.windowStart, scheduling.windowEnd, payload.buildingAddress ?? "", payload.apartment ?? "", payload.entrance ?? "", payload.intercom ?? "", composition.categoryId, composition.duration, composition.durationSource, payload.clientVisitConfirmed ? 1 : 0,
        ),
      ...orderCompositionStatements(context.database, id, composition),
      ...(isEmergency ? [emergencyWindowAudit(context.database,context.organizationId,id,context.user.id,
        {start:payload.clientWindowStart ?? null,end:payload.clientWindowEnd ?? null,timezone:scheduling.timezone},scheduling,now)] : []),
      ...(reason ? [schedulingChangeStatement(context.database, context.organizationId, id, context.user.id, "manual", reason, null, after, now)] : []),
      ...(payload.clientVisitConfirmed ? [clientAudit(context.database, context.organizationId, id, context.user.id, "client_visit_confirmation_changed", { confirmed: true, before: null, after }, now)] : []),
      context.database.prepare(`INSERT INTO work_order_status_history
        (id, work_order_id, from_status, to_status, changed_by_user_id, reason, created_at)
        VALUES (?, ?, NULL, ?, ?, 'Создание заявки', ?)`).bind(crypto.randomUUID(), id, databaseStatus, context.user.id, now),
    ]);

    const items = await listRequests(context.database, context.organizationId);
    return NextResponse.json({ item: items.find((item) => item.id === id) }, { status: 201 });
  } catch (error) {
    return requestError(error);
  }
}

export async function PUT(request: Request) {
  try {
    const context = await requireApiContext(request, "requests.manage");
    if (isApiError(context)) return context;
    const body = await readJsonObject(request);
    const payload = parsePayload(body);
    if (!payload || typeof body?.id !== "string" || !body.id) return badRequest();
    const existing = await context.database.prepare(`SELECT client_visit_confirmed, scheduled_start, scheduled_end, status, service_object_id, address_snapshot, building_address, apartment, entrance, intercom, client_window_start, client_window_end,
      COALESCE(scheduling_timezone, (SELECT timezone FROM organizations WHERE id = work_orders.organization_id)) AS scheduling_timezone, latitude_snapshot, longitude_snapshot, revision, assignee_worker_id,
      (SELECT full_name FROM workers WHERE id = work_orders.assignee_worker_id) AS assignee_name
      FROM work_orders WHERE id = ? AND organization_id = ? LIMIT 1`).bind(body.id, context.organizationId).first<{
        scheduled_start: string; scheduled_end: string | null; client_visit_confirmed: number;
        status: string;
        building_address: string; apartment: string; entrance: string; intercom: string;
        scheduling_timezone: string; client_window_start: string | null; client_window_end: string | null;
        service_object_id: string | null;
        address_snapshot: string;
        latitude_snapshot: number | null;
        longitude_snapshot: number | null;
        revision: number;
        assignee_worker_id: string | null;
        assignee_name: string | null;
      }>();
    if (!existing) return NextResponse.json({ message: "Заявка не найдена." }, { status: 404 });
    if (typeof body.revision === "number" && body.revision !== existing.revision) return conflict("Заявка изменена исполнителем или диспетчером. Обновите список и откройте её снова.");
    if (payload.status === "paused" && existing.status !== "paused") return conflict("Приостановка выполняется сообщением о проблеме из мобильного приложения.");
    if (existing.status === "paused" && payload.status !== "paused") return conflict("Сначала исполнитель должен нажать «Продолжить» в мобильном приложении.");
    if (payload.status === "confirmed" && !["completed", "confirmed"].includes(existing.status)) return conflict("Подтвердить можно только завершённую заявку.");
    const previousComposition = (await loadOrderCompositions(context.database, context.organizationId)).get(body.id)!;
    const composition = await resolveOrderComposition(context.database, context.organizationId, payload, previousComposition);
    const isEmergency=composition.components.some(item=>item.isEmergency);
    if(isEmergency)payload.priority="high";
    const workTypeVersion = { id: composition.components[0].versionId, plannedDurationMinutes: composition.duration };
    const scheduling = requestScheduling(payload, payload.dateTime, workTypeVersion.plannedDurationMinutes, existing.scheduling_timezone, existing,isEmergency);
    const scheduledEnd = scheduling.scheduledEnd;
    const assigneeId = await eligibleCompositionWorker(context.database, context.organizationId, payload.assignee, composition,
      payload.assigneeId || (payload.assignee === existing.assignee_name ? existing.assignee_worker_id ?? undefined : undefined));
    if (payload.assignee && !assigneeId) return badRequest("Исполнитель не соответствует требованиям выбранного типа работ.");
    const buildingAddress = payload.buildingAddress ?? existing.building_address;
    const point = (existing.building_address || existing.address_snapshot) === (buildingAddress || payload.address)
      && isCoordinate(existing.latitude_snapshot, -90, 90)
      && isCoordinate(existing.longitude_snapshot, -180, 180)
      ? { lat: existing.latitude_snapshot, lon: existing.longitude_snapshot }
      : (await geocodeAddress(buildingAddress || payload.address)).point;
    const now = new Date().toISOString();
    const databaseStatus = payload.status === "working" && existing.status === "en_route" ? "en_route" : toDatabaseStatus(payload.status);
    const clientVisitConfirmed = payload.clientVisitConfirmed ?? Boolean(existing.client_visit_confirmed);
    const before: ScheduleSnapshot = { workerId: existing.assignee_worker_id, workerName: existing.assignee_name ?? "", start: existing.scheduled_start, end: existing.scheduled_end, timezone: existing.scheduling_timezone, windowStart: existing.client_window_start, windowEnd: existing.client_window_end };
    if(previousComposition.components.some(item=>item.isEmergency)) Object.assign(before,emergencyWindow(existing.scheduled_start,existing.scheduling_timezone));
    const after: ScheduleSnapshot = { workerId: assigneeId, workerName: payload.assignee, start: payload.dateTime, end: scheduledEnd, timezone: scheduling.timezone, windowStart: scheduling.windowStart, windowEnd: scheduling.windowEnd };
    const reason = manualSchedulingReason(before, after);
    const clientReason = reason || (existing.address_snapshot !== payload.address ? "Диспетчер изменил адрес визита." : databaseStatus === "cancelled" && existing.status !== "cancelled" ? "Диспетчер отменил визит." : !clientVisitConfirmed ? "Диспетчер снял подтверждение визита." : null);
    const requiresNotification = Boolean(existing.client_visit_confirmed && clientReason);
    if (requiresNotification && (payload.clientNotified !== true || body.revision !== existing.revision)) return conflict("Сообщите клиенту об изменении подтверждённого визита и явно отметьте это в актуальной карточке заявки.");
    const statements = [
      context.database.prepare(`INSERT INTO mobile_commands (user_id, operation_id, fingerprint, accepted, created_at)
        VALUES (?, ?, 'web-request-update', CASE WHEN EXISTS (SELECT 1 FROM work_orders WHERE id = ? AND organization_id = ? AND revision = ?) THEN 1 ELSE 0 END, ?)`)
        .bind(context.user.id, crypto.randomUUID(), body.id, context.organizationId, existing.revision, now),
      context.database.prepare(`UPDATE work_orders SET work_type_version_id = ?, assignee_worker_id = ?,
        confirmed_by_user_id = ?, description = ?, priority = ?, status = ?, scheduled_start = ?, scheduled_end = ?, address_snapshot = ?,
        latitude_snapshot = ?, longitude_snapshot = ?, scheduling_timezone = ?, client_window_start = ?, client_window_end = ?,
        building_address = ?, apartment = ?, entrance = ?, intercom = ?, category_id = ?, service_duration_minutes = ?, duration_source = ?,
        completed_at = CASE WHEN ? = 'completed' AND completed_at IS NULL THEN ? ELSE completed_at END,
        confirmed_at = CASE WHEN ? = 'confirmed' THEN COALESCE(confirmed_at, ?) ELSE confirmed_at END,
        client_visit_confirmed = ?, updated_at = ? WHERE id = ? AND organization_id = ?`).bind(
          workTypeVersion.id, assigneeId, databaseStatus === "confirmed" ? context.user.id : null,
          payload.description, payload.priority, databaseStatus, payload.dateTime, scheduledEnd, payload.address, point.lat, point.lon,
          scheduling.timezone, scheduling.windowStart, scheduling.windowEnd, buildingAddress,
          payload.apartment ?? existing.apartment, payload.entrance ?? existing.entrance, payload.intercom ?? existing.intercom, composition.categoryId, composition.duration, composition.durationSource,
          databaseStatus, now, databaseStatus, now, clientVisitConfirmed ? 1 : 0, now, body.id, context.organizationId,
        ),
    ];
    // Departure freezes the equipment via a DB trigger; it must see the new composition.
    statements.splice(1,0,...orderCompositionStatements(context.database, body.id, composition));
    if (reason || requiresNotification) statements.push(schedulingChangeStatement(context.database, context.organizationId, body.id, context.user.id, "manual", (reason || clientReason!) + (requiresNotification ? " Диспетчер подтвердил, что сообщил клиенту." : ""), before, after, now));
    if (requiresNotification) statements.push(clientAudit(context.database, context.organizationId, body.id, context.user.id, "client_notified", { source: "manual", reason: clientReason, before, after, previousRevision: existing.revision }, now));
    if (clientVisitConfirmed !== Boolean(existing.client_visit_confirmed)) statements.push(clientAudit(context.database, context.organizationId, body.id, context.user.id, "client_visit_confirmation_changed", { confirmed: clientVisitConfirmed, before, after }, now));
    if (databaseStatus === "confirmed" && existing.status !== "confirmed") {
      statements.push(context.database.prepare(`INSERT INTO report_reviews (id, report_id, reviewer_type, reviewer_user_id, decision, reason, created_at)
        SELECT ?, id, 'dispatcher', ?, 'accepted', 'Подтверждение в карточке заявки', ? FROM work_reports
        WHERE work_order_id = ? AND status IN ('submitted', 'manual_review')`).bind(crypto.randomUUID(), context.user.id, now, body.id));
      statements.push(context.database.prepare(`UPDATE work_reports SET status = 'accepted', accepted_at = ?, updated_at = ?
        WHERE work_order_id = ? AND status IN ('submitted', 'manual_review')`).bind(now, now, body.id));
    }
    if (existing.service_object_id) {
      statements.push(context.database.prepare("UPDATE service_objects SET address = ?, latitude = ?, longitude = ?, updated_at = ? WHERE id = ?").bind(payload.address, point.lat, point.lon, now, existing.service_object_id));
    }
    if (existing.status !== databaseStatus) {
      statements.push(context.database.prepare(`INSERT INTO work_order_status_history
        (id, work_order_id, from_status, to_status, changed_by_user_id, reason, created_at)
        VALUES (?, ?, ?, ?, ?, 'Изменение в форме заявки', ?)`).bind(crypto.randomUUID(), body.id, existing.status, databaseStatus, context.user.id, now));
    }
    if(isEmergency && (existing.client_window_start!==scheduling.windowStart || existing.client_window_end!==scheduling.windowEnd)) {
      statements.push(emergencyWindowAudit(context.database,context.organizationId,body.id,context.user.id,
        {start:existing.client_window_start,end:existing.client_window_end,timezone:existing.scheduling_timezone,suppliedStart:payload.clientWindowStart,suppliedEnd:payload.clientWindowEnd},scheduling,now));
    }
    await context.database.batch(statements);

    const items = await listRequests(context.database, context.organizationId);
    return NextResponse.json({ item: items.find((item) => item.id === body.id) });
  } catch (error) {
    return requestError(error);
  }
}

async function listRequests(database: D1Database, organizationId: string, workerId?: string): Promise<RequestItem[]> {
  const result = await database.prepare(`SELECT work_orders.id, work_orders.number, work_orders.revision, work_orders.assignee_worker_id, work_orders.work_type_version_id, work_types.name AS work, work_orders.description,
      work_orders.priority, work_orders.status, work_orders.client_visit_confirmed, work_orders.scheduled_start AS date_time,
      COALESCE(work_orders.scheduling_timezone, organizations.timezone) AS scheduling_timezone,
      work_orders.client_window_start, work_orders.client_window_end, work_orders.building_address, work_orders.apartment, work_orders.entrance, work_orders.intercom,
      work_orders.address_snapshot AS address, work_orders.latitude_snapshot AS latitude,
      work_orders.longitude_snapshot AS longitude, workers.full_name AS assignee,
      work_reports.id AS report_id, report_worker.full_name AS performer,
      work_reports.submitted_at, work_reports.comment AS report_comment, work_reports.field_values_json AS report_fields
    FROM work_orders
    JOIN organizations ON organizations.id = work_orders.organization_id
    JOIN work_type_versions ON work_type_versions.id = work_orders.work_type_version_id
    JOIN work_types ON work_types.id = work_type_versions.work_type_id
    LEFT JOIN workers ON workers.id = work_orders.assignee_worker_id
    LEFT JOIN work_reports ON work_reports.id = (
      SELECT latest.id FROM work_reports AS latest WHERE latest.work_order_id = work_orders.id ORDER BY latest.revision DESC LIMIT 1
    )
    LEFT JOIN workers AS report_worker ON report_worker.id = work_reports.performer_worker_id
    WHERE work_orders.organization_id = ? ${workerId ? "AND work_orders.assignee_worker_id = ?" : ""} ORDER BY work_orders.scheduled_start DESC`).bind(organizationId, ...(workerId ? [workerId] : [])).all<RequestRow>();
  const reportIds = result.results.flatMap((row) => row.report_id ? [row.report_id] : []);
  const compositions = await loadOrderCompositions(database, organizationId);
  const mediaByReport = new Map<string, CompletionMedia[]>();
  if (reportIds.length) {
    const placeholders = reportIds.map(() => "?").join(",");
    const mediaResult = await database.prepare(`SELECT id, report_id, kind, file_name, size_bytes, storage_key
      FROM report_media WHERE report_id IN (${placeholders}) AND upload_status = 'uploaded' ORDER BY created_at`).bind(...reportIds).all<{ id: string; report_id: string; kind: "photo" | "video"; file_name: string; size_bytes: number; storage_key: string }>();
    for (const media of mediaResult.results) {
      const items = mediaByReport.get(media.report_id) ?? [];
      items.push({ id: media.id, kind: media.kind, name: media.file_name, meta: formatFileSize(media.size_bytes), url: media.storage_key.startsWith("demo/") ? undefined : `/api/media/${encodeURIComponent(media.id)}` });
      mediaByReport.set(media.report_id, items);
    }
  }

  const issueSchema = await database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'mobile_issues'").first();
  const issues = issueSchema ? (await database.prepare(`SELECT i.id, i.work_order_id, i.reason, i.detail, i.created_at, w.full_name AS worker_name FROM mobile_issues i
    JOIN work_orders o ON o.id = i.work_order_id JOIN workers w ON w.id = i.worker_id
    WHERE o.organization_id = ? ${workerId ? "AND o.assignee_worker_id = ?" : ""} ORDER BY i.created_at DESC, i.id`).bind(organizationId, ...(workerId ? [workerId] : [])).all<{ id: string; work_order_id: string; reason: string; detail: string; created_at: string; worker_name: string }>()).results : [];
  const changes = await loadSchedulingChanges(database, organizationId, workerId);
  for(const row of result.results) if(compositions.get(row.id)!.components.some(item=>item.isEmergency)) {
    const window=emergencyWindow(row.date_time,row.scheduling_timezone);
    row.client_window_start=window.windowStart;row.client_window_end=window.windowEnd;row.priority="high";
  }
  const items: RequestItem[] = result.results.map((row) => ({
    isEmergency:compositions.get(row.id)!.components.some(item=>item.isEmergency),
    clientVisitConfirmed: Boolean(row.client_visit_confirmed),
    schedulingChanges: changes.get(row.id) ?? [],
    id: row.id,
    number: row.number,
    work: compositions.get(row.id)!.components.map(item => item.name).join(" + "),
    categoryId: compositions.get(row.id)!.categoryId ?? "",
    workTypeIds: compositions.get(row.id)!.components.map(item => item.workTypeId),
    workTypeVersionIds: compositions.get(row.id)!.components.map(item => item.versionId),
    serviceDurationMinutes: compositions.get(row.id)!.duration,
    durationSource: compositions.get(row.id)!.durationSource,
    equipment: compositions.get(row.id)!.equipment,
    requiredSkills: [],
    requiredQualifications: [],
    description: row.description,
    problems: issues.filter(i => i.work_order_id === row.id).map(i => `${i.reason}: ${i.detail}`),
    problemLog: issues.filter(i => i.work_order_id === row.id).map(i => ({ id: i.id, reason: i.reason, detail: i.detail, createdAt: i.created_at, workerName: i.worker_name })),
    priority: row.priority,
    status: fromDatabaseStatus(row.status),
    ...((row.status==='en_route' || row.status==='in_progress') ? {executionStatus:row.status as 'en_route'|'in_progress'} : {}),
    dateTime: row.date_time,
    schedulingTimezone: row.scheduling_timezone,
    clientWindowStart: row.client_window_start ? instantToRegionalTime(row.client_window_start, row.scheduling_timezone).slice(0, 16) : "",
    clientWindowEnd: row.client_window_end ? instantToRegionalTime(row.client_window_end, row.scheduling_timezone).slice(0, 16) : "",
    buildingAddress: row.building_address, apartment: row.apartment, entrance: row.entrance, intercom: row.intercom,
    address: row.address,
    point: isCoordinate(row.latitude, -90, 90) && isCoordinate(row.longitude, -180, 180)
      ? { lat: row.latitude, lon: row.longitude }
      : null,
    assignee: row.assignee ?? "",
    assigneeId: row.assignee_worker_id ?? "",
    revision: row.revision,
    completionReport: row.report_id ? {
      performer: row.performer ?? row.assignee ?? "Исполнитель",
      submittedAt: formatSubmittedAt(row.submitted_at),
      comment: row.report_comment ?? "",
      sections:readReportSections(row.report_fields ?? '{}'),
      media: mediaByReport.get(row.report_id) ?? [],
    } : undefined,
  }));
  const issued=await departmentEquipment(database,organizationId);
  return items.map(item => ({ ...item, equipmentWarning:equipmentWarning(item.equipment ?? [],issued.get(item.assigneeId ?? "")?.[item.dateTime.slice(0,10)]),
    scheduleConflicts: findServiceConflicts(item, items, item.schedulingTimezone!) }));
}

function clientAudit(database: D1Database, organizationId: string, orderId: string, userId: string, action: string, payload: unknown, now: string) {
  return database.prepare(`INSERT INTO audit_events (id,organization_id,actor_user_id,entity_type,entity_id,action,payload_json,created_at)
    VALUES (?,?,?,'work_order',?,?,?,?)`).bind(crypto.randomUUID(), organizationId, userId, orderId, action, JSON.stringify(payload), now);
}

function emergencyWindowAudit(database: D1Database, organizationId: string, orderId: string, userId: string, source: unknown, effective: { windowStart: string | null; windowEnd: string | null; timezone: string }, now: string) {
  return clientAudit(database, organizationId, orderId, userId, "emergency_window_normalized", {
    source, effective: { start: effective.windowStart, end: effective.windowEnd, timezone: effective.timezone },
    reason: "Авария: календарные сутки региона, выполнить как можно раньше.",
  }, now);
}

function parsePayload(body: Record<string, unknown> | null): RequestPayload | null {
  if (!body || !isText(body.work) || !isText(body.description, true) || !isText(body.dateTime) || !isText(body.address) || !isText(body.assignee, true)) return null;
  if (!isPriority(body.priority) || !isStatus(body.status)) return null;
  const metadata: Partial<RequestPayload> = {};
  for (const key of ["clientVisitConfirmed", "clientNotified"] as const) {
    if (body[key] !== undefined) { if (typeof body[key] !== "boolean") return null; metadata[key] = body[key]; }
  }
  if (body.workTypeIds !== undefined) { if (!isUniqueIds(body.workTypeIds) || !body.workTypeIds.length) return null; metadata.workTypeIds = body.workTypeIds; }
  if (body.serviceDurationMinutes !== undefined) { if (typeof body.serviceDurationMinutes !== "number") return null; metadata.serviceDurationMinutes = body.serviceDurationMinutes; }
  for (const key of ["categoryId", "assigneeId", "durationSource"] as const) {
    if (body[key] !== undefined) { if (!isText(body[key], true)) return null; metadata[key] = body[key].trim(); }
  }
  for (const key of ["buildingAddress", "apartment", "entrance", "intercom", "clientWindowStart", "clientWindowEnd"] as const) {
    if (body[key] !== undefined) {
      if (!isText(body[key], true) || (key !== "buildingAddress" && body[key].length > 100)) return null;
      metadata[key] = body[key].trim();
    }
  }
  return { ...metadata, id: typeof body.id === "string" ? body.id : "", work: body.work.trim(), description: body.description.trim(), priority: body.priority, status: body.status, dateTime: body.dateTime, address: body.address.trim(), assignee: body.assignee.trim() };
}

async function listRequestEngineers(database: D1Database, organizationId: string): Promise<RequestEngineer[]> {
  const workers = await database.prepare(`SELECT id, full_name AS name, load_percent AS load,
    CASE (${WORKER_TRANSPORT_SQL}) WHEN 'car' THEN 'Автомобиль' ELSE 'Общественный транспорт + пешком' END AS vehicle
    FROM workers WHERE organization_id = ? AND active = 1 ORDER BY full_name`).bind(organizationId).all<{ id: string; name: string; load: number; vehicle: string }>();
  const ids = workers.results.map((worker) => worker.id);
  if (!ids.length) return [];
  const placeholders = ids.map(() => "?").join(",");
  const now = new Date().toISOString();
  const [skillRows, qualificationRows] = await Promise.all([
    database.prepare(`SELECT worker_skills.worker_id, skills.name FROM worker_skills
      JOIN skills ON skills.id = worker_skills.skill_id
      WHERE worker_skills.worker_id IN (${placeholders}) AND skills.active = 1 ORDER BY skills.name`).bind(...ids).all<{ worker_id: string; name: string }>(),
    database.prepare(`SELECT worker_qualifications.worker_id, qualifications.name FROM worker_qualifications
      JOIN qualifications ON qualifications.id = worker_qualifications.qualification_id
      WHERE worker_qualifications.worker_id IN (${placeholders}) AND qualifications.active = 1
        AND worker_qualifications.status IN ('valid', 'expiring')
        AND (worker_qualifications.expires_at IS NULL OR worker_qualifications.expires_at >= ?)
      ORDER BY qualifications.name`).bind(...ids, now).all<{ worker_id: string; name: string }>(),
  ]);
  const competencies = await listWorkerCompetencies(database, organizationId);
  const issued=await departmentEquipment(database,organizationId);
  return workers.results.map((worker) => ({
    ...worker, workCompetencies: competencies.get(worker.id) ?? [], equipmentByDate:issued.get(worker.id) ?? {},
    skills: skillRows.results.filter((row) => row.worker_id === worker.id).map((row) => row.name),
    qualifications: qualificationRows.results.filter((row) => row.worker_id === worker.id).map((row) => row.name),
  }));
}

function isText(value: unknown, allowEmpty = false): value is string {
  return typeof value === "string" && value.length <= 2000 && (allowEmpty || value.trim().length > 0);
}
function isCoordinate(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum;
}
function requestError(error: unknown) {
  if (error instanceof WorkCatalogError) return NextResponse.json({ message: error.message }, { status: error.status });
  if (error instanceof RangeError) return badRequest(error.message);
  if (String(error).includes("mobile_command_precondition")) return conflict("Заявка изменилась. Обновите список и повторите действие.");
  if (error instanceof GeocodingError) {
    const status = error.code === "NOT_FOUND" ? 400 : error.code === "NOT_CONFIGURED" ? 503 : 502;
    return NextResponse.json({ message: error.message }, { status });
  }
  return serverError(error);
}
function isPriority(value: unknown): value is RequestPriority { return value === "high" || value === "medium" || value === "low"; }
function isStatus(value: unknown): value is RequestStatus { return value === "new" || value === "assigned" || value === "working" || value === "paused" || value === "completed" || value === "confirmed" || value === "cancelled"; }
function toDatabaseStatus(status: RequestStatus) { return status === "working" ? "in_progress" : status; }
function fromDatabaseStatus(status: string): RequestStatus {
  if (status === "cancelled") return "cancelled";
  if (status === "paused") return "paused";
  if (status === "in_progress" || status === "en_route") return "working";
  if (status === "confirmed") return "confirmed";
  if (status === "completed") return "completed";
  if (status === "assigned") return "assigned";
  return "new";
}
function formatSubmittedAt(value: string | null) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Moscow" }).format(new Date(value)).replace(".", "");
}
function formatFileSize(size: number) { return `${(size / 1_000_000).toLocaleString("ru-RU", { maximumFractionDigits: 1 })} МБ`; }
