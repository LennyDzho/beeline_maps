import { NextResponse } from "next/server";
import { permissionCatalog, type PermissionId, type SystemRoleId } from "@/app/admin/role-data";
import { listRoles } from "@/app/api/admin/_data";
import { badRequest, isApiError, readJsonObject, requireApiContext, serverError } from "@/app/api/_shared";

export async function PUT(request: Request) {
  try {
    const context = await requireApiContext(request, "admin.roles");
    if (isApiError(context)) return context;
    const body = await readJsonObject(request);
    if (!body || !isRoleId(body.id) || !isPermissionArray(body.permissions)) return badRequest();
    const role = await context.database.prepare("SELECT id FROM roles WHERE organization_id = ? AND code = ? LIMIT 1").bind(context.organizationId, body.id).first<{ id: string }>();
    if (!role) return NextResponse.json({ message: "Роль не найдена." }, { status: 404 });
    await context.database.batch([
      context.database.prepare("DELETE FROM role_permissions WHERE role_id = ?").bind(role.id),
      ...body.permissions.map((permission) => context.database.prepare("INSERT INTO role_permissions (role_id, permission_code) VALUES (?, ?)").bind(role.id, permission)),
    ]);
    const roles = await listRoles(context.database, context.organizationId);
    return NextResponse.json({ item: roles.find((item) => item.id === body.id) });
  } catch (error) { return serverError(error); }
}

function isRoleId(value: unknown): value is SystemRoleId { return value === "dispatcher" || value === "executor" || value === "administrator"; }
function isPermissionArray(value: unknown): value is PermissionId[] {
  const valid = new Set(permissionCatalog.map((item) => item.id));
  return Array.isArray(value) && value.every((item) => typeof item === "string" && valid.has(item as PermissionId));
}
