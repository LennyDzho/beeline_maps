import { env } from "cloudflare:workers";

type AuthEnvironment = {
  DB?: D1Database;
  AUTH_BOOTSTRAP_EMAIL?: string;
  AUTH_BOOTSTRAP_PASSWORD?: string;
  AUTH_BOOTSTRAP_NAME?: string;
};

const runtimeEnv = env as unknown as AuthEnvironment;
let schemaInitialization: Promise<void> | null = null;

export function getAuthDatabase(): D1Database {
  if (!runtimeEnv.DB) {
    throw new Error("D1 binding `DB` is unavailable for application authentication.");
  }

  return runtimeEnv.DB;
}

export async function ensureAuthSchema(): Promise<D1Database> {
  const database = getAuthDatabase();

  schemaInitialization ??= initializeSchema(database).catch((error) => {
    schemaInitialization = null;
    throw error;
  });

  await schemaInitialization;
  return database;
}

export function getBootstrapCredentials() {
  const email = runtimeEnv.AUTH_BOOTSTRAP_EMAIL?.trim().toLowerCase();
  const password = runtimeEnv.AUTH_BOOTSTRAP_PASSWORD;
  const displayName = runtimeEnv.AUTH_BOOTSTRAP_NAME?.trim() || "Администратор";

  if (!email || !password) return null;
  return { email, password, displayName };
}

async function initializeSchema(database: D1Database): Promise<void> {
  await database.batch([
    database.prepare(`CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY NOT NULL,
      email TEXT NOT NULL,
      display_name TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'dispatcher',
      password_salt TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      password_iterations INTEGER NOT NULL,
      must_change_password INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`),
    database.prepare("CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique ON users (email)"),
    database.prepare(`CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY NOT NULL,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`),
    database.prepare("CREATE UNIQUE INDEX IF NOT EXISTS sessions_token_hash_unique ON sessions (token_hash)"),
    database.prepare("CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions (user_id)"),
    database.prepare("CREATE INDEX IF NOT EXISTS sessions_expires_at_idx ON sessions (expires_at)"),
    database.prepare(`CREATE TABLE IF NOT EXISTS auth_login_attempts (
      email TEXT PRIMARY KEY NOT NULL,
      failed_attempts INTEGER NOT NULL DEFAULT 0,
      locked_until TEXT,
      updated_at TEXT NOT NULL
    )`),
    database.prepare("CREATE INDEX IF NOT EXISTS auth_login_attempts_updated_at_idx ON auth_login_attempts (updated_at)"),
  ]);

  const userColumns = await database.prepare("PRAGMA table_info(users)").all<{ name: string }>();
  if (!userColumns.results.some((column) => column.name === "must_change_password")) {
    await database.prepare("ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0").run();
  }
}
