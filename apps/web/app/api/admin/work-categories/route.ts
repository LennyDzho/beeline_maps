import { NextResponse } from "next/server";
import { badRequest, isApiError, readJsonObject, requireApiContext, serverError } from "@/app/api/_shared";
import { listWorkCategories } from "@/app/lib/server/work-catalog";
import { isEquipmentRequirements } from "@/app/lib/work-catalog";
import { isPlannedDurationMinutes } from "@/app/lib/planned-duration";

export async function GET(request: Request) {
  try { const context = await requireApiContext(request, "admin.settings"); if (isApiError(context)) return context;
    return NextResponse.json({ items: await listWorkCategories(context.database) });
  } catch (error) { return serverError(error); }
}
async function save(request: Request, editing: boolean) {
  try {
    const context = await requireApiContext(request, "admin.settings"); if (isApiError(context)) return context;
    const body = await readJsonObject(request);
    if (!body || typeof body.name !== "string" || !body.name.trim() || body.name.length > 200 || typeof body.description !== "string" || body.description.length > 2000 || typeof body.active !== "boolean") return badRequest();
    const id = editing ? body.id : `BK-${crypto.randomUUID()}`;
    if (typeof id !== "string") return badRequest();
    const previous = editing ? await context.database.prepare("SELECT service_duration_minutes, duration_source FROM work_categories WHERE id=?").bind(id)
      .first<{ service_duration_minutes: number | null; duration_source: string }>() : null;
    if (editing && !previous) return NextResponse.json({ message: "Тип ВК не найден." }, { status: 404 });
    const duration = body.serviceDurationMinutes === undefined ? previous?.service_duration_minutes ?? null : body.serviceDurationMinutes;
    const source = body.durationSource === undefined
      ? duration === null ? "" : previous?.service_duration_minutes === duration && previous.duration_source.trim() ? previous.duration_source : "Норматив ВК"
      : body.durationSource;
    if ((duration !== null && !isPlannedDurationMinutes(duration)) || typeof source !== "string" || source.length > 2000 || (duration !== null && !source.trim())) return badRequest("Для норматива ВК укажите минуты обслуживания без дороги и источник.");
    if (body.equipment !== undefined && !isEquipmentRequirements(body.equipment)) return badRequest("Проверьте оборудование и количество.");
    if (body.equipment !== undefined) {
      const items = await context.database.prepare("SELECT id FROM equipment_items WHERE active=1").all<{id:string}>();
      if (!body.equipment.every(e=>items.results.some(row=>row.id===e.equipmentId))) return badRequest("Выберите действующее оборудование.");
    }
    const statements: D1PreparedStatement[] = [];
    const now = new Date().toISOString();
    if (editing) statements.push(context.database.prepare("UPDATE work_categories SET name=?, description=?, active=?, service_duration_minutes=?, duration_source=?, updated_at=? WHERE id=?")
      .bind(body.name.trim(), body.description.trim(), Number(body.active), duration, source.trim(), now, id));
    else statements.push(context.database.prepare("INSERT INTO work_categories (id,organization_id,name,description,active,service_duration_minutes,duration_source,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)")
      .bind(id, context.organizationId, body.name.trim(), body.description.trim(), Number(body.active), duration, source.trim(), now, now));
    if (body.equipment !== undefined) statements.push(
      context.database.prepare("UPDATE work_categories SET equipment_configured=1 WHERE id=?").bind(id),
      context.database.prepare("DELETE FROM category_equipment WHERE category_id=?").bind(id),
      ...body.equipment.map(e=>context.database.prepare("INSERT INTO category_equipment(category_id,equipment_id,quantity) VALUES(?,?,?)").bind(id,e.equipmentId,e.quantity)),
    );
    await context.database.batch(statements);
    return NextResponse.json({ item: (await listWorkCategories(context.database)).find(item => item.id === id) }, { status: editing ? 200 : 201 });
  } catch (error) {
    if (String(error).includes("UNIQUE")) return NextResponse.json({ message: "Тип ВК с таким названием уже существует." }, { status: 409 });
    return serverError(error);
  }
}
export const POST = (request: Request) => save(request, false);
export const PUT = (request: Request) => save(request, true);
