import { NextResponse } from "next/server";
import type { WorkScheduleDay, WorkScheduleRecord } from "@/app/admin/work-schedule-data";
import { listWorkSchedules } from "@/app/api/admin/_data";
import { badRequest, conflict, isApiError, readJsonObject, requireApiContext, serverError } from "@/app/api/_shared";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const context = await requireApiContext(request, "admin.settings");
    if (isApiError(context)) return context;
    return NextResponse.json({ items: await listWorkSchedules(context.database, context.organizationId) });
  } catch (error) { return serverError(error); }
}

export async function POST(request: Request) {
  try {
    const context = await requireApiContext(request, "admin.settings");
    if (isApiError(context)) return context;
    const payload = parseSchedule(await readJsonObject(request));
    if (!payload) return badRequest("Проверьте название, рабочие часы и перерывы.");
    if (await nameExists(context.database, context.organizationId, payload.name)) return conflict("График с таким названием уже существует.");
    const id = `SCHEDULE-${crypto.randomUUID()}`;
    await saveSchedule(context.database, context.organizationId, { ...payload, id }, false);
    const items = await listWorkSchedules(context.database, context.organizationId);
    return NextResponse.json({ item: items.find((item) => item.id === id) }, { status: 201 });
  } catch (error) { return serverError(error); }
}

export async function PUT(request: Request) {
  try {
    const context = await requireApiContext(request, "admin.settings");
    if (isApiError(context)) return context;
    const body = await readJsonObject(request);
    const payload = parseSchedule(body);
    if (!payload || typeof body?.id !== "string") return badRequest("Проверьте название, рабочие часы и перерывы.");
    const exists = await context.database.prepare("SELECT id FROM work_schedules WHERE id = ? AND organization_id = ?").bind(body.id, context.organizationId).first();
    if (!exists) return NextResponse.json({ message: "Рабочий график не найден." }, { status: 404 });
    if (await nameExists(context.database, context.organizationId, payload.name, body.id)) return conflict("График с таким названием уже существует.");
    await saveSchedule(context.database, context.organizationId, { ...payload, id: body.id }, true);
    const items = await listWorkSchedules(context.database, context.organizationId);
    return NextResponse.json({ item: items.find((item) => item.id === body.id) });
  } catch (error) { return serverError(error); }
}

function parseSchedule(body: Record<string, unknown> | null): Omit<WorkScheduleRecord, "id"> | null {
  if (!body || typeof body.name !== "string" || !body.name.trim() || body.name.length > 120 || typeof body.active !== "boolean" || !Array.isArray(body.days) || body.days.length !== 7) return null;
  const days = body.days.flatMap((value): WorkScheduleDay[] => {
    if (!value || typeof value !== "object") return [];
    const day = value as Record<string, unknown>;
    if (!Number.isInteger(day.weekday) || Number(day.weekday) < 1 || Number(day.weekday) > 7 || typeof day.enabled !== "boolean") return [];
    const startTime = time(day.startTime);
    const endTime = time(day.endTime);
    const breakStart = optionalTime(day.breakStart);
    const breakEnd = optionalTime(day.breakEnd);
    if (day.enabled && (!startTime || !endTime || startTime >= endTime)) return [];
    if ((breakStart || breakEnd) && (!breakStart || !breakEnd || breakStart >= breakEnd || !startTime || !endTime || breakStart < startTime || breakEnd > endTime)) return [];
    return [{ weekday: Number(day.weekday), enabled: day.enabled, startTime: day.enabled ? startTime! : "", endTime: day.enabled ? endTime! : "", breakStart: day.enabled ? breakStart : "", breakEnd: day.enabled ? breakEnd : "" }];
  });
  if (days.length !== 7 || new Set(days.map((day) => day.weekday)).size !== 7 || !days.some((day) => day.enabled)) return null;
  return { name: body.name.trim(), active: body.active, days: days.sort((left, right) => left.weekday - right.weekday) };
}

async function saveSchedule(database: D1Database, organizationId: string, schedule: WorkScheduleRecord, replaceDays: boolean) {
  const now = new Date().toISOString();
  const statements: D1PreparedStatement[] = [replaceDays
    ? database.prepare("UPDATE work_schedules SET name = ?, active = ?, updated_at = ? WHERE id = ? AND organization_id = ?").bind(schedule.name, schedule.active ? 1 : 0, now, schedule.id, organizationId)
    : database.prepare("INSERT INTO work_schedules (id, organization_id, name, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").bind(schedule.id, organizationId, schedule.name, schedule.active ? 1 : 0, now, now)];
  if (replaceDays) statements.push(database.prepare("DELETE FROM work_schedule_days WHERE schedule_id = ?").bind(schedule.id));
  for (const day of schedule.days) {
    statements.push(database.prepare(`INSERT INTO work_schedule_days
      (schedule_id, weekday, enabled, start_time, end_time, break_start, break_end) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .bind(schedule.id, day.weekday, day.enabled ? 1 : 0, day.enabled ? day.startTime : null, day.enabled ? day.endTime : null, day.enabled && day.breakStart ? day.breakStart : null, day.enabled && day.breakEnd ? day.breakEnd : null));
  }
  await database.batch(statements);
}

async function nameExists(database: D1Database, organizationId: string, name: string, excludedId = "") {
  return Boolean(await database.prepare("SELECT id FROM work_schedules WHERE organization_id = ? AND LOWER(name) = LOWER(?) AND id <> ? LIMIT 1").bind(organizationId, name, excludedId).first());
}
function time(value: unknown) { return typeof value === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(value) ? value : ""; }
function optionalTime(value: unknown) { return value === "" || value === null || value === undefined ? "" : time(value); }
