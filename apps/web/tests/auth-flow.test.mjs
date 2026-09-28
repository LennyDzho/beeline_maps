import assert from "node:assert/strict";
import { pbkdf2Sync } from "node:crypto";
import { register } from "node:module";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

register(new URL("./cloudflare-loader.mjs", import.meta.url));

test("first login, redirect and logout use the current session without a second login", async (t) => {
  // Isolated in-memory D1: no local application database, credentials or sessions.
  const db = new DatabaseSync(":memory:");
  t.after(() => { db.close(); delete globalThis[Symbol.for("mmi.test.cloudflare.env")]; });
  db.exec(`CREATE TABLE users (
    id TEXT PRIMARY KEY, email TEXT, display_name TEXT, role TEXT, password_salt TEXT,
    password_hash TEXT, password_iterations INTEGER, status TEXT, must_change_password INTEGER,
    created_at TEXT, updated_at TEXT
  )`);
  const password = "isolated-test-password";
  const salt = Buffer.from("isolated-auth-test-salt");
  const hash = pbkdf2Sync(password, salt, 1000, 32, "sha256").toString("base64");
  db.prepare("INSERT INTO users VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run("test-user", "test@example.invalid", "Тестовый диспетчер", "dispatcher", salt.toString("base64"), hash, 1000, "active", 0, new Date().toISOString(), new Date().toISOString());
  const database = {
    prepare(sql) {
      return {
        values: [], bind(...values) { this.values = values; return this; },
        async first() { return db.prepare(sql).get(...this.values) ?? null; },
        async all() { return { results: db.prepare(sql).all(...this.values) }; },
        async run() { return db.prepare(sql).run(...this.values); },
      };
    },
    async batch(statements) {
      db.exec("BEGIN");
      try { const results = []; for (const statement of statements) results.push(await statement.run()); db.exec("COMMIT"); return results; }
      catch (error) { db.exec("ROLLBACK"); throw error; }
    },
  };
  globalThis[Symbol.for("mmi.test.cloudflare.env")] = { DB: database };
  const { default: worker } = await import(new URL("../dist/server/index.js", import.meta.url));
  const request = (path, { cookie, ...options } = {}) => worker.fetch(new Request(`http://localhost${path}`, {
    ...options, headers: { accept: "text/html", ...(cookie ? { cookie } : {}), ...options.headers },
  }), {}, { waitUntil() {}, passThroughOnException() {} });
  const login = () => request("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json", origin: "http://localhost" }, body: JSON.stringify({ email: "test@example.invalid", password }) });

  const anonymous = await request("/");
  assert.equal(anonymous.status, 307);
  assert.equal(anonymous.headers.get("location"), "/login");
  const form = await request("/login");
  assert.equal(form.status, 200);
  await form.text();

  const signedIn = await login();
  assert.equal(signedIn.status, 200);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sessions").get().count, 1);
  const cookieHeader = signedIn.headers.get("set-cookie");
  assert.match(cookieHeader, /^mmi_session=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=43200$/);
  const cookie = cookieHeader.split(";")[0];
  await signedIn.json();

  // No delay, retry or second POST: the very next request must be authorized.
  const home = await request("/", { cookie });
  assert.equal(home.status, 200);
  assert.equal(home.headers.get("location"), null);
  const html = await home.text();
  assert.match(html, /Планирование выездов/);
  assert.doesNotMatch(html, /Вход в систему/);
  const alreadySignedIn = await request("/login", { cookie });
  assert.equal(alreadySignedIn.status, 307);
  assert.equal(alreadySignedIn.headers.get("location"), "/");

  const otherBrowser = await request("/");
  assert.equal(otherBrowser.status, 307);
  assert.equal(otherBrowser.headers.get("location"), "/login");
  const logout = await request("/api/auth/logout", { cookie, method: "POST", headers: { origin: "http://localhost" } });
  assert.equal(logout.status, 303);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sessions").get().count, 0);
  const oldSession = await request("/", { cookie });
  assert.equal(oldSession.status, 307);
  assert.equal(oldSession.headers.get("location"), "/login");

  // Both directions of session-dependent navigation must be non-cacheable.
  for (const response of [anonymous, form, signedIn, home, alreadySignedIn, otherBrowser, logout, oldSession]) {
    assert.match(response.headers.get("cache-control") ?? "", /\bno-store\b/, `HTTP ${response.status} must not cache authentication state`);
    assert.match(response.headers.get("vary") ?? "", /\bCookie\b/i);
  }
});
