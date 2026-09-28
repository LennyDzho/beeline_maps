import { NextResponse } from "next/server";
import type { Vehicle, VehicleStatus } from "@/app/resources/resource-data";
import { badRequest, conflict, isApiError, readJsonObject, requireApiContext, serverError } from "@/app/api/_shared";

export const dynamic = "force-dynamic";

type ResourceRow = {
  id: string; name: string; type: Vehicle["type"]; plate: string | null; region: string | null; status: VehicleStatus;
  assignment: string | null; condition: string; service_date: string | null; vin: string | null; section: string | null; notes: string;
  planned_jobs: number; next_planned_at: string | null;
};

export async function GET(request: Request) {
  try {
    const context = await requireApiContext(request, "resources.manage");
    if (isApiError(context)) return context;
    const items = await listResources(context.database, context.organizationId);
    const engineers = await context.database.prepare("SELECT id, full_name AS name FROM workers WHERE organization_id = ? AND active = 1 ORDER BY full_name").bind(context.organizationId).all<{ id: string; name: string }>();
    return NextResponse.json({ items, engineers: engineers.results });
  } catch (error) { return serverError(error); }
}

export async function POST(request: Request) {
  try {
    const context = await requireApiContext(request, "resources.manage");
    if (isApiError(context)) return context;
    const payload = parsePayload(await readJsonObject(request));
    if (!payload) return badRequest();
    if (payload.vin && await vinExists(context.database, context.organizationId, payload.vin)) return conflict("Ресурс с таким VIN уже существует.");
    const numeric = await context.database.prepare("SELECT MAX(CAST(SUBSTR(id, 5) AS INTEGER)) AS value FROM resources WHERE id LIKE 'RES-%'").first<{ value: number | null }>();
    const id = `RES-${String((numeric?.value ?? 0) + 1).padStart(3, "0")}`;
    const references = await resolveReferences(context.database, context.organizationId, payload);
    if (!references) return badRequest("Выбранный участок не найден.");
    const now = new Date().toISOString();
    await context.database.prepare(`INSERT INTO resources
      (id, organization_id, service_area_id, assigned_worker_id, name, type, plate, region, vin, status, condition, next_service_at, notes, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
        id, context.organizationId, references.areaId, references.workerId, payload.name, payload.type, payload.plate,
        payload.region, payload.vin || null, payload.status, toDatabaseCondition(payload.condition), payload.serviceDate || null,
        payload.notes ?? "", now, now,
      ).run();
    const items = await listResources(context.database, context.organizationId);
    return NextResponse.json({ item: items.find((item) => item.id === id) }, { status: 201 });
  } catch (error) { return serverError(error); }
}

export async function PUT(request: Request) {
  try {
    const context = await requireApiContext(request, "resources.manage");
    if (isApiError(context)) return context;
    const body = await readJsonObject(request);
    const payload = parsePayload(body);
    if (!payload || typeof body?.id !== "string") return badRequest();
    const exists = await context.database.prepare("SELECT id FROM resources WHERE id = ? AND organization_id = ?").bind(body.id, context.organizationId).first();
    if (!exists) return NextResponse.json({ message: "Ресурс не найден." }, { status: 404 });
    if (payload.vin && await vinExists(context.database, context.organizationId, payload.vin, body.id)) return conflict("Ресурс с таким VIN уже существует.");
    const references = await resolveReferences(context.database, context.organizationId, payload);
    if (!references) return badRequest("Выбранный участок не найден.");
    await context.database.prepare(`UPDATE resources SET service_area_id = ?, assigned_worker_id = ?, name = ?, type = ?, plate = ?, region = ?, vin = ?,
      status = ?, condition = ?, next_service_at = ?, notes = ?, updated_at = ? WHERE id = ? AND organization_id = ?`).bind(
        references.areaId, references.workerId, payload.name, payload.type, payload.plate, payload.region, payload.vin || null,
        payload.status, toDatabaseCondition(payload.condition), payload.serviceDate || null, payload.notes ?? "", new Date().toISOString(), body.id, context.organizationId,
      ).run();
    const items = await listResources(context.database, context.organizationId);
    return NextResponse.json({ item: items.find((item) => item.id === body.id) });
  } catch (error) { return serverError(error); }
}

async function listResources(database: D1Database, organizationId: string): Promise<Vehicle[]> {
  const result = await database.prepare(`SELECT resources.id, resources.name, resources.type, resources.plate, resources.region,
      resources.status, workers.full_name AS assignment, resources.condition, resources.next_service_at AS service_date,
      resources.vin, service_areas.name AS section, resources.notes,
      COUNT(work_orders.id) AS planned_jobs, MIN(work_orders.scheduled_start) AS next_planned_at
    FROM resources LEFT JOIN workers ON workers.id = resources.assigned_worker_id
    LEFT JOIN service_areas ON service_areas.id = resources.service_area_id
    LEFT JOIN work_orders ON work_orders.resource_id = resources.id AND work_orders.status IN ('assigned', 'en_route', 'in_progress')
    WHERE resources.organization_id = ? GROUP BY resources.id ORDER BY resources.name`).bind(organizationId).all<ResourceRow>();
  return result.results.map((row) => ({
    id: row.id, name: row.name, type: row.type, plate: row.plate ?? "", region: row.region ?? "", status: row.status,
    assignment: row.assignment ?? undefined, condition: row.condition === "serviceable" ? "Исправен" : "service",
    plannedJobs: row.planned_jobs, nextPlannedAt: row.next_planned_at ?? undefined,
    serviceDate: row.service_date ?? undefined, vin: row.vin ?? undefined, section: row.section ?? undefined, notes: row.notes,
  }));
}

function parsePayload(body: Record<string, unknown> | null): Vehicle | null {
  if (!body || !isText(body.name) || !isVehicleType(body.type) || !isText(body.plate) || !isText(body.region) || !isStatus(body.status) || !isCondition(body.condition) || (body.section !== undefined && (typeof body.section !== "string" || body.section.length>500))) return null;
  const serviceDate = typeof body.serviceDate === "string" ? body.serviceDate : "";
  if (body.condition === "service" && !serviceDate) return null;
  return { id: typeof body.id === "string" ? body.id : "", name: body.name.trim(), type: body.type, plate: body.plate.trim().toUpperCase(), region: body.region.trim(), status: body.status, condition: body.condition, assignment: typeof body.assignment === "string" && body.assignment ? body.assignment : undefined, serviceDate: serviceDate || undefined, vin: typeof body.vin === "string" && body.vin ? body.vin.trim().toUpperCase() : undefined, section: typeof body.section === "string" ? body.section : "", notes: typeof body.notes === "string" ? body.notes.trim() : "" };
}

async function resolveReferences(database: D1Database, organizationId: string, payload: Vehicle) {
  const area = await database.prepare("SELECT id FROM service_areas WHERE organization_id = ? AND name = ? AND active = 1 LIMIT 1").bind(organizationId, payload.section ?? "").first<{ id: string }>();
  if (payload.section && !area) return null;
  let workerId: string | null = null;
  if (payload.assignment) {
    const worker = await database.prepare("SELECT id FROM workers WHERE organization_id = ? AND full_name = ? AND active = 1 LIMIT 1").bind(organizationId, payload.assignment).first<{ id: string }>();
    workerId = worker?.id ?? null;
  }
  return { areaId: area?.id ?? null, workerId };
}
async function vinExists(database: D1Database, organizationId: string, vin: string, excludedId = "") { return Boolean(await database.prepare("SELECT id FROM resources WHERE organization_id = ? AND vin = ? AND id <> ? LIMIT 1").bind(organizationId, vin, excludedId).first()); }
function toDatabaseCondition(condition: Vehicle["condition"]) { return condition === "Исправен" ? "serviceable" : "service_required"; }
function isText(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0 && value.length <= 500; }
function isVehicleType(value: unknown): value is Vehicle["type"] { return value === "Фургон" || value === "Легковой"; }
function isStatus(value: unknown): value is VehicleStatus { return value === "working" || value === "repair" || value === "available"; }
function isCondition(value: unknown): value is Vehicle["condition"] { return value === "Исправен" || value === "service"; }
