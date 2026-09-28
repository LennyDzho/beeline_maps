import { NextResponse } from "next/server";
import type { SystemRoleId } from "@/app/admin/role-data";
import type { SystemUser, SystemUserStatus } from "@/app/admin/user-data";
import { listAdminUsers } from "@/app/api/admin/_data";
import { badRequest, conflict, isApiError, readJsonObject, requireApiContext, serverError } from "@/app/api/_shared";
import { createPasswordRecord } from "@/auth/crypto";

export const dynamic = "force-dynamic";

type UserPayload = { user: SystemUser & { roleId: SystemRoleId }; password: string; requirePasswordChange: boolean };

export async function POST(request: Request) {
  try {
    const context = await requireApiContext(request, "admin.users");
    if (isApiError(context)) return context;
    const payload = parsePayload(await readJsonObject(request), true);
    if (!payload) return badRequest("Проверьте данные пользователя и временный пароль.");
    if (await emailExists(context.database, payload.user.email)) return conflict("Пользователь с таким email уже существует.");
    const role = await resolveRole(context.database, context.organizationId, payload.user.roleId);
    if (!role) return badRequest("Выбранная роль не найдена.");
    const passwordRecord = await createPasswordRecord(payload.password);
    const numeric = await context.database.prepare("SELECT MAX(CAST(SUBSTR(id, 5) AS INTEGER)) AS value FROM users WHERE id LIKE 'USR-%'").first<{ value: number | null }>();
    const id = `USR-${String((numeric?.value ?? 0) + 1).padStart(3, "0")}`;
    const now = new Date().toISOString();
    await context.database.batch([
      context.database.prepare(`INSERT INTO users
        (id, email, display_name, role, password_salt, password_hash, password_iterations, must_change_password, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(id, payload.user.email, payload.user.name, payload.user.roleId, passwordRecord.salt, passwordRecord.hash, passwordRecord.iterations, payload.requirePasswordChange ? 1 : 0, toDatabaseStatus(payload.user.status), now, now),
      context.database.prepare(`INSERT INTO memberships (id, organization_id, user_id, role_id, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'active', ?, ?)`).bind(`MEM-${id}`, context.organizationId, id, role.id, now, now),
    ]);
    const users = await listAdminUsers(context.database, context.organizationId);
    return NextResponse.json({ item: users.find((item) => item.id === id) }, { status: 201 });
  } catch (error) { return serverError(error); }
}

export async function PUT(request: Request) {
  try {
    const context = await requireApiContext(request, "admin.users");
    if (isApiError(context)) return context;
    const body = await readJsonObject(request);
    const payload = parsePayload(body, false);
    if (!payload || typeof payload.user.id !== "string" || !payload.user.id) return badRequest();
    const existing = await context.database.prepare(`SELECT users.id FROM users JOIN memberships ON memberships.user_id = users.id
      WHERE users.id = ? AND memberships.organization_id = ? LIMIT 1`).bind(payload.user.id, context.organizationId).first();
    if (!existing) return NextResponse.json({ message: "Пользователь не найден." }, { status: 404 });
    if (await emailExists(context.database, payload.user.email, payload.user.id)) return conflict("Пользователь с таким email уже существует.");
    const role = await resolveRole(context.database, context.organizationId, payload.user.roleId);
    if (!role) return badRequest("Выбранная роль не найдена.");
    const now = new Date().toISOString();
    const statements = [
      context.database.prepare(`UPDATE users SET email = ?, display_name = ?, role = ?, must_change_password = ?, status = ?, updated_at = ? WHERE id = ?`).bind(payload.user.email, payload.user.name, payload.user.roleId, payload.requirePasswordChange ? 1 : 0, toDatabaseStatus(payload.user.status), now, payload.user.id),
      context.database.prepare(`INSERT INTO memberships (id, organization_id, user_id, role_id, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'active', ?, ?)
        ON CONFLICT(organization_id, user_id) DO UPDATE SET role_id = excluded.role_id, status = 'active', updated_at = excluded.updated_at`).bind(`MEM-${payload.user.id}`, context.organizationId, payload.user.id, role.id, now, now),
    ];
    if (payload.password) {
      const record = await createPasswordRecord(payload.password);
      statements.push(context.database.prepare("UPDATE users SET password_salt = ?, password_hash = ?, password_iterations = ?, updated_at = ? WHERE id = ?").bind(record.salt, record.hash, record.iterations, now, payload.user.id));
    }
    if (payload.password || payload.user.status === "blocked") statements.push(context.database.prepare("DELETE FROM sessions WHERE user_id = ?").bind(payload.user.id));
    await context.database.batch(statements);
    const users = await listAdminUsers(context.database, context.organizationId);
    return NextResponse.json({ item: users.find((item) => item.id === payload.user.id) });
  } catch (error) { return serverError(error); }
}

export async function PATCH(request: Request) {
  try {
    const context = await requireApiContext(request, "admin.roles");
    if (isApiError(context)) return context;
    const body = await readJsonObject(request);
    if (!body || typeof body.id !== "string" || !isRoleIdOrNull(body.roleId)) return badRequest();
    const now = new Date().toISOString();
    if (body.roleId === null) {
      await context.database.prepare("DELETE FROM memberships WHERE organization_id = ? AND user_id = ?").bind(context.organizationId, body.id).run();
    } else {
      const role = await resolveRole(context.database, context.organizationId, body.roleId);
      if (!role) return badRequest("Выбранная роль не найдена.");
      await context.database.batch([
        context.database.prepare(`INSERT INTO memberships (id, organization_id, user_id, role_id, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, 'active', ?, ?)
          ON CONFLICT(organization_id, user_id) DO UPDATE SET role_id = excluded.role_id, status = 'active', updated_at = excluded.updated_at`).bind(`MEM-${body.id}`, context.organizationId, body.id, role.id, now, now),
        context.database.prepare("UPDATE users SET role = ?, updated_at = ? WHERE id = ?").bind(body.roleId, now, body.id),
      ]);
    }
    const users = await listAdminUsers(context.database, context.organizationId);
    return NextResponse.json({ item: users.find((item) => item.id === body.id) });
  } catch (error) { return serverError(error); }
}

function parsePayload(body: Record<string, unknown> | null, creating: boolean): UserPayload | null {
  const user = body?.user;
  if (!user || typeof user !== "object" || Array.isArray(user)) return null;
  const item = user as Record<string, unknown>;
  if (!isText(item.name) || !isEmail(item.email) || !isRoleId(item.roleId) || !isStatus(item.status)) return null;
  const password = typeof body?.password === "string" ? body.password : "";
  if ((creating && password.length < 8) || password.length > 128 || typeof body?.requirePasswordChange !== "boolean") return null;
  return { user: { id: typeof item.id === "string" ? item.id : "", initials: initials(item.name), name: item.name.trim(), email: item.email.trim().toLowerCase(), roleId: item.roleId, status: item.status, statusLabel: item.status === "blocked" ? "Заблокирован" : item.status === "active" ? "Активен" : "Не в сети", activity: typeof item.activity === "string" ? item.activity : "Ещё не входил" }, password, requirePasswordChange: body.requirePasswordChange };
}
async function resolveRole(database: D1Database, organizationId: string, roleId: SystemRoleId) { return database.prepare("SELECT id FROM roles WHERE organization_id = ? AND code = ? LIMIT 1").bind(organizationId, roleId).first<{ id: string }>(); }
async function emailExists(database: D1Database, email: string, excludedId = "") { return Boolean(await database.prepare("SELECT id FROM users WHERE email = ? AND id <> ? LIMIT 1").bind(email, excludedId).first()); }
function toDatabaseStatus(status: SystemUserStatus) { return status === "blocked" ? "blocked" : "active"; }
function isText(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0 && value.length <= 300; }
function isEmail(value: unknown): value is string { return typeof value === "string" && value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value.trim()); }
function isRoleId(value: unknown): value is SystemRoleId { return value === "dispatcher" || value === "executor" || value === "administrator"; }
function isRoleIdOrNull(value: unknown): value is SystemRoleId | null { return value === null || isRoleId(value); }
function isStatus(value: unknown): value is SystemUserStatus { return value === "active" || value === "offline" || value === "blocked"; }
function initials(name: string) { return name.trim().split(/\s+/u).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join("") || "П"; }
