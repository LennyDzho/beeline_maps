import { NextResponse } from "next/server";
import { badRequest, isApiError, readJsonObject, requireApiContext, serverError } from "@/app/api/_shared";
import { listEquipmentItems } from "@/app/lib/server/work-catalog";

export async function GET(request: Request) {
  try { const context = await requireApiContext(request, "admin.settings"); if (isApiError(context)) return context;
    return NextResponse.json({ items: await listEquipmentItems(context.database) });
  } catch (error) { return serverError(error); }
}
async function save(request: Request, editing: boolean) {
  try {
    const context = await requireApiContext(request, "admin.settings"); if (isApiError(context)) return context;
    const body = await readJsonObject(request);
    if (!body || typeof body.name !== "string" || !body.name.trim() || body.name.length > 200 || typeof body.unit !== "string" || body.unit.length > 50 || !["unspecified", "consumable", "reusable"].includes(String(body.usage)) || typeof body.active !== "boolean") return badRequest();
    const id = editing ? body.id : `EQ-${crypto.randomUUID()}`;
    if (typeof id !== "string") return badRequest();
    if (editing && !await context.database.prepare("SELECT id FROM equipment_items WHERE id=?").bind(id).first()) return NextResponse.json({ message: "Оборудование не найдено." }, { status: 404 });
    const now = new Date().toISOString();
    if (editing) await context.database.prepare("UPDATE equipment_items SET name=?, unit=?, usage=?, active=?, updated_at=? WHERE id=?")
      .bind(body.name.trim(), body.unit.trim(), body.usage, Number(body.active), now, id).run();
    else await context.database.prepare("INSERT INTO equipment_items (id,organization_id,name,unit,usage,active,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)")
      .bind(id, context.organizationId, body.name.trim(), body.unit.trim(), body.usage, Number(body.active), now, now).run();
    return NextResponse.json({ item: (await listEquipmentItems(context.database)).find(item => item.id === id) }, { status: editing ? 200 : 201 });
  } catch (error) {
    if (String(error).includes("UNIQUE")) return NextResponse.json({ message: "Оборудование с таким названием уже существует." }, { status: 409 });
    return serverError(error);
  }
}
export const POST = (request: Request) => save(request, false);
export const PUT = (request: Request) => save(request, true);
