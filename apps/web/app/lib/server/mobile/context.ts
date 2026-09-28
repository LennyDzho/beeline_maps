import { authenticateWithPassword, deleteSession, getUserForSessionToken, isValidLoginInput, type AuthUser } from "@/auth/session";
import { hashSessionToken } from "@/auth/crypto";
import { ensureDomainData } from "@/db/domain-storage";

import { MobileError } from "./errors";
export { MobileError } from "./errors";
export type MobileContext = {
  database: D1Database; user: AuthUser; token: string; workerId: string; organizationId: string;
  workerName: string; organizationName: string; timezone: string; onShift: boolean; mustChangePassword: boolean;
};
type Binding = { worker_id: string; organization_id: string; worker_name: string; organization_name: string; timezone: string; shift_status: string; must_change_password: number };
const bindingSelect = `SELECT w.id AS worker_id, w.organization_id, w.full_name AS worker_name,
  o.name AS organization_name, COALESCE(w.timezone,o.timezone) AS timezone, w.shift_status, u.must_change_password
  FROM workers w JOIN users u ON u.id = w.user_id
  JOIN organizations o ON o.id = w.organization_id AND o.status = 'active'
  JOIN memberships m ON m.user_id = u.id AND m.organization_id = o.id AND m.status = 'active'
  JOIN role_permissions rp ON rp.role_id = m.role_id AND rp.permission_code = 'mobile.execute'
  WHERE u.id = ? AND u.status = 'active' AND w.active = 1`;

export function bearer(request: Request) {
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/u.exec(request.headers.get("authorization") ?? "");
  if (!match) throw new MobileError(401, "Войдите в приложение.");
  return match[1];
}
export async function mobileLogin(body: Record<string, unknown>) {
  if (!isValidLoginInput(body.email, body.password)) throw new MobileError(400, "Проверьте email и пароль.");
  const result = await authenticateWithPassword(body.email, body.password as string);
  if (!result.ok) throw new MobileError(result.reason === "locked" ? 429 : 401,
    result.reason === "locked" ? "Слишком много попыток. Повторите через 15 минут." : "Неверный email или пароль.");
  try {
    const database = await ensureDomainData(result.user);
    const binding = await database.prepare(bindingSelect).bind(result.user.id).first<Binding>();
    if (!binding) throw new MobileError(403, "Учётная запись не привязана к активному исполнителю. Обратитесь к администратору.");
    await database.prepare(`INSERT INTO mobile_session_bindings (session_id, worker_id, organization_id)
      SELECT id, ?, ? FROM sessions WHERE token_hash = ?`).bind(binding.worker_id, binding.organization_id, await hashSessionToken(result.token)).run();
    return { token: result.token, expiresAt: result.expiresAt.toISOString(), mustChangePassword: Boolean(binding.must_change_password),
      user: { id: result.user.id, name: binding.worker_name, email: result.user.email, organization: binding.organization_name } };
  } catch (error) { await deleteSession(result.token); throw error; }
}
export async function requireMobileContext(request: Request, allowPasswordChange = false): Promise<MobileContext> {
  const token = bearer(request);
  const user = await getUserForSessionToken(token);
  if (!user) throw new MobileError(401, "Сессия истекла. Войдите снова.");
  const database = await ensureDomainData(user);
  const row = await database.prepare(`${bindingSelect} AND EXISTS (
    SELECT 1 FROM mobile_session_bindings b JOIN sessions s ON s.id = b.session_id
    WHERE s.token_hash = ? AND b.worker_id = w.id AND b.organization_id = w.organization_id)
    LIMIT 1`).bind(user.id, await hashSessionToken(token)).first<Binding>();
  if (!row) throw new MobileError(403, "Доступ исполнителя изменён. Обратитесь к администратору.");
  if (row.must_change_password && !allowPasswordChange) throw new MobileError(428, "Смените временный пароль.");
  return { database, user, token, workerId: row.worker_id, organizationId: row.organization_id,
    workerName: row.worker_name, organizationName: row.organization_name, timezone: row.timezone,
    onShift: row.shift_status === "on_shift", mustChangePassword: Boolean(row.must_change_password) };
}
export async function objectBody(request: Request) {
  if (Number(request.headers.get("content-length") ?? 0) > 65536) throw new MobileError(413, "Запрос слишком большой.");
  const source = await request.text();
  if (new TextEncoder().encode(source).byteLength > 65536) throw new MobileError(413, "Запрос слишком большой.");
  try {
    const body: unknown = JSON.parse(source);
    if (body && typeof body === "object" && !Array.isArray(body)) return body as Record<string, unknown>;
  } catch { /* Invalid JSON is a client error. */ }
  throw new MobileError(400, "Некорректный запрос.");
}
export const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
