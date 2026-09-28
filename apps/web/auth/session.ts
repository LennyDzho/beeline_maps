import { cookies } from "next/headers";
import { createPasswordRecord, createSessionToken, hashSessionToken, timingSafeTextEqual, verifyPassword } from "./crypto";
import { ensureAuthSchema, getBootstrapCredentials } from "./storage";

const SESSION_COOKIE = "mmi_session";
const SESSION_TTL_SECONDS = 60 * 60 * 12;
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MINUTES = 15;

type UserRow = {
  id: string;
  email: string;
  display_name: string;
  role: string;
  password_salt: string;
  password_hash: string;
  password_iterations: number;
  status: string;
};

type AttemptRow = {
  failed_attempts: number;
  locked_until: string | null;
};

export type AuthUser = {
  id: string;
  email: string;
  displayName: string;
  role: string;
};

export type LoginResult =
  | { ok: true; user: AuthUser; token: string; expiresAt: Date }
  | { ok: false; reason: "invalid" | "locked" | "unconfigured" };

export async function authenticateWithPassword(emailInput: string, password: string): Promise<LoginResult> {
  const email = normalizeEmail(emailInput);
  const database = await ensureAuthSchema();
  const attempt = await database
    .prepare("SELECT failed_attempts, locked_until FROM auth_login_attempts WHERE email = ? LIMIT 1")
    .bind(email)
    .first<AttemptRow>();

  if (attempt?.locked_until && new Date(attempt.locked_until).getTime() > Date.now()) {
    return { ok: false, reason: "locked" };
  }

  let user = await database
    .prepare(`SELECT id, email, display_name, role, password_salt, password_hash,
      password_iterations, status FROM users WHERE email = ? LIMIT 1`)
    .bind(email)
    .first<UserRow>();

  if (!user) {
    const bootstrap = getBootstrapCredentials();
    if (!bootstrap) return { ok: false, reason: "unconfigured" };

    const bootstrapMatches =
      timingSafeTextEqual(email, bootstrap.email) && timingSafeTextEqual(password, bootstrap.password);

    if (!bootstrapMatches) {
      await recordFailedAttempt(database, email, attempt?.failed_attempts ?? 0);
      return { ok: false, reason: "invalid" };
    }

    const passwordRecord = await createPasswordRecord(password);
    const now = new Date().toISOString();
    const userId = crypto.randomUUID();

    await database
      .prepare(`INSERT INTO users (
        id, email, display_name, role, password_salt, password_hash,
        password_iterations, status, created_at, updated_at
      ) VALUES (?, ?, ?, 'admin', ?, ?, ?, 'active', ?, ?)`)
      .bind(
        userId,
        email,
        bootstrap.displayName,
        passwordRecord.salt,
        passwordRecord.hash,
        passwordRecord.iterations,
        now,
        now,
      )
      .run();

    user = {
      id: userId,
      email,
      display_name: bootstrap.displayName,
      role: "admin",
      password_salt: passwordRecord.salt,
      password_hash: passwordRecord.hash,
      password_iterations: passwordRecord.iterations,
      status: "active",
    };
  }

  if (user.status !== "active") {
    await recordFailedAttempt(database, email, attempt?.failed_attempts ?? 0);
    return { ok: false, reason: "invalid" };
  }

  const passwordMatches = await verifyPassword(
    password,
    user.password_salt,
    user.password_hash,
    user.password_iterations,
  );

  if (!passwordMatches) {
    await recordFailedAttempt(database, email, attempt?.failed_attempts ?? 0);
    return { ok: false, reason: "invalid" };
  }

  await database.prepare("DELETE FROM auth_login_attempts WHERE email = ?").bind(email).run();
  await database.prepare("DELETE FROM sessions WHERE expires_at <= ?").bind(new Date().toISOString()).run();

  const token = createSessionToken();
  const tokenHash = await hashSessionToken(token);
  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + SESSION_TTL_SECONDS * 1000);

  await database
    .prepare("INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(crypto.randomUUID(), user.id, tokenHash, expiresAt.toISOString(), createdAt.toISOString())
    .run();

  return { ok: true, user: toAuthUser(user), token, expiresAt };
}

export async function getCurrentUser(): Promise<AuthUser | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;
  if (!token) return null;

  const database = await ensureAuthSchema();
  const mobileSchema = await database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'mobile_session_bindings'").first();
  if (mobileSchema && await database.prepare(`SELECT 1 FROM mobile_session_bindings b JOIN sessions s ON s.id = b.session_id WHERE s.token_hash = ?`).bind(await hashSessionToken(token)).first()) return null;
  return getUserForSessionToken(token);
}

export async function getUserForSessionToken(token: string): Promise<AuthUser | null> {
  if (!/^[A-Za-z0-9_-]{43}$/u.test(token)) return null;

  const database = await ensureAuthSchema();
  const tokenHash = await hashSessionToken(token);
  const row = await database
    .prepare(`SELECT users.id, users.email, users.display_name, users.role
      FROM sessions
      JOIN users ON users.id = sessions.user_id
      WHERE sessions.token_hash = ? AND sessions.expires_at > ? AND users.status = 'active'
      LIMIT 1`)
    .bind(tokenHash, new Date().toISOString())
    .first<{ id: string; email: string; display_name: string; role: string }>();

  return row ? toAuthUser(row) : null;
}

export async function deleteSession(token: string | undefined): Promise<void> {
  if (!token) return;
  const database = await ensureAuthSchema();
  const tokenHash = await hashSessionToken(token);
  await database.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(tokenHash).run();
}

export function getSessionCookieName(): string {
  return SESSION_COOKIE;
}

export function createSessionCookie(token: string, secure: boolean): string {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_SECONDS}${secure ? "; Secure" : ""}`;
}

export function clearSessionCookie(secure: boolean): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? "; Secure" : ""}`;
}

export function isValidLoginInput(email: unknown, password: unknown): email is string {
  return (
    typeof email === "string" &&
    typeof password === "string" &&
    email.length <= 254 &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email.trim()) &&
    password.length >= 8 &&
    password.length <= 128
  );
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function toAuthUser(row: { id: string; email: string; display_name: string; role: string }): AuthUser {
  return { id: row.id, email: row.email, displayName: row.display_name, role: row.role };
}

async function recordFailedAttempt(database: D1Database, email: string, previousAttempts: number): Promise<void> {
  const failedAttempts = previousAttempts + 1;
  const lockedUntil =
    failedAttempts >= MAX_FAILED_ATTEMPTS
      ? new Date(Date.now() + LOCKOUT_MINUTES * 60 * 1000).toISOString()
      : null;

  await database
    .prepare(`INSERT INTO auth_login_attempts (email, failed_attempts, locked_until, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(email) DO UPDATE SET
        failed_attempts = excluded.failed_attempts,
        locked_until = excluded.locked_until,
        updated_at = excluded.updated_at`)
    .bind(email, failedAttempts, lockedUntil, new Date().toISOString())
    .run();
}
