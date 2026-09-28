import assert from "node:assert/strict";
import { pbkdf2Sync } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { register } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

register(new URL("../cloudflare-loader.mjs", import.meta.url));

/** Real built Worker + all real migrations. Never opens a file database or .dev.vars.
 * One fixture per process: the production Worker caches its environment/schema.
 * Individual scenarios are rolled back with savepoints, including D1 batches.
 */
export async function isolatedWorker({ prepareDatabase, coldStart = false } = {}) {
  const db = new DatabaseSync(":memory:");
  const originalFetch = globalThis.fetch;
  let batchNumber = 0;
  const database = {
    prepare(sql) {
      const statement = {
        values: [],
        bind(...values) { this.values = values; return this; },
        async first(column) {
          const row = db.prepare(sql).get(...this.values) ?? null;
          return column ? row?.[column] ?? null : row;
        },
        async all() { return { success: true, results: db.prepare(sql).all(...this.values) }; },
        async run() {
          const result = db.prepare(sql).run(...this.values);
          return { success: true, meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
        },
      };
      return statement;
    },
    async batch(statements) {
      const name = `d1_batch_${++batchNumber}`;
      db.exec(`SAVEPOINT ${name}`);
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        db.exec(`RELEASE ${name}`);
        return results;
      } catch (error) {
        db.exec(`ROLLBACK TO ${name}; RELEASE ${name}`);
        throw error;
      }
    },
  };
  const fixture = {
    db, database, cookie: "", calls: [], geocodingFailure: false, solverHandler: null, osrmHandler: null, twoGisHandler: null,
    handle(request) { return worker.fetch(request, {}, { waitUntil() {}, passThroughOnException() {} }); },
    async request(path, { method = "GET", body, cookie = fixture.cookie, origin = "http://isolated.test", ...options } = {}) {
      assert.ok(path.startsWith("/") && !path.startsWith("//"), "only in-process application paths are allowed");
      return worker.fetch(new Request(`http://isolated.test${path}`, {
        method, ...options,
        headers: { accept: "application/json", ...(cookie ? { cookie } : {}), origin,
          ...(body === undefined ? {} : { "content-type": "application/json" }), ...options.headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }), {}, { waitUntil() {}, passThroughOnException() {} });
    },
    async json(path, options, status = 200) {
      const response = await fixture.request(path, options);
      const text = await response.text();
      assert.equal(response.status, status, `${options?.method ?? "GET"} ${path}: ${text.slice(0, 600)}`);
      return JSON.parse(text);
    },
    close() {
      globalThis.fetch = originalFetch;
      delete globalThis[Symbol.for("mmi.test.cloudflare.env")];
      db.close();
    },
  };
  // Hard network isolation. These are canned protocol responses, NOT a live
  // verification of a mapping subscription, street geometry or ETA accuracy.
  globalThis.fetch = async (input, options) => {
    const url = new URL(input instanceof Request ? input.url : input);
    fixture.calls.push(url.hostname + url.pathname);
    if (url.hostname === "routing.api.2gis.com" && fixture.twoGisHandler) return fixture.twoGisHandler(url, JSON.parse(options.body));
    if (url.hostname === "optimizer.test") {
      const input = JSON.parse(options.body);
      if (fixture.solverHandler) return fixture.solverHandler(input);
      const python = process.env.OPTIMIZER_TEST_PYTHON ?? fileURLToPath(new URL(process.platform === "win32" ? "../../../../algorithm-research/benchmark/.venv/Scripts/python.exe" : "../../../../algorithm-research/benchmark/.venv/bin/python", import.meta.url));
      return Response.json(JSON.parse(execFileSync(python,[fileURLToPath(new URL("../../../../services/optimizer/solver.py",import.meta.url))],{
        input:JSON.stringify({...input,timeLimitMs:300}),encoding:"utf8",timeout:15000,windowsHide:true,
      })));
    }
    if (url.hostname === "catalog.api.2gis.com" && url.pathname.endsWith("/geocode")) {
      if (fixture.geocodingFailure) return Response.json({ meta: { code: 404 }, result: { items: [] } }, { status: 404 });
      return Response.json({ meta: { code: 200 }, result: { items: [{ id: "fixture-building", type: "building",
        full_name: "Москва, Тестовая улица, 1", point: { lat: 55.76, lon: 37.61 } }] } });
    }
    if (url.hostname === "osrm.test") {
      if (fixture.osrmHandler) return fixture.osrmHandler(url);
      const coordinates = url.pathname.split("/").at(-1).split(";").map((pair) => pair.split(",").map(Number));
      if (url.pathname.startsWith("/table/v1/")) {
        const indices = (key) => (url.searchParams.get(key) ?? coordinates.map((_, i) => i).join(";")).split(";").map(Number);
        const sources = indices("sources"), targets = indices("destinations");
        return Response.json({ code: "Ok", durations: sources.map((s) => targets.map((d) => s === d ? 0 : 300)),
          distances: sources.map((s) => targets.map((d) => s === d ? 0 : 1000)) });
      }
      if (url.pathname.startsWith("/route/v1/")) return Response.json({ code: "Ok", routes: [{
        distance: (coordinates.length - 1) * 1000, duration: (coordinates.length - 1) * 300,
        geometry: { type: "LineString", coordinates }, legs: coordinates.slice(1).map((point,index) => ({ duration: 300, distance: 1000,steps:[{geometry:{type:"LineString",coordinates:[coordinates[index],point]}}] })),
      }] });
    }
    throw new Error(`Unexpected external request blocked by test fixture: ${url.hostname}${url.pathname}`);
  };
  let worker;
  try {
    const migrationsUrl = new URL("../../drizzle/", import.meta.url);
    const migrations = (await readdir(migrationsUrl)).filter((name) => /^\d+_.+\.sql$/.test(name)).sort();
    db.exec("CREATE TABLE domain_schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
    for (const name of migrations) {
      if (coldStart && !name.startsWith("0000_")) continue;
      db.exec(await readFile(new URL(name, migrationsUrl), "utf8"));
      db.prepare("INSERT INTO domain_schema_migrations VALUES (?, ?)").run(name.replace(/\.sql$/, ""), new Date().toISOString());
    }
    db.exec("PRAGMA foreign_keys=ON");
    const salt = Buffer.from("isolated-api-salt");
    const password = "isolated-test-password";
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO users (id,email,display_name,role,password_salt,password_hash,password_iterations,status,${coldStart ? "" : "must_change_password,"}created_at,updated_at)
      VALUES ('QA-ADMIN','qa@example.invalid','Тестовый администратор','administrator',?,?,1000,'active',${coldStart ? "" : "0,"}?,?)`)
      .run(salt.toString("base64"), pbkdf2Sync(password, salt, 1000, 32, "sha256").toString("base64"), now, now);
    if (prepareDatabase) await prepareDatabase(database, db, "QA-ADMIN");
    globalThis[Symbol.for("mmi.test.cloudflare.env")] = { DB: database, TWO_GIS_API_KEY: "not-a-real-key",
      OPTIMIZER_SERVICE_URL:"https://optimizer.test", OPTIMIZER_SERVICE_TOKEN:"fixture-only-token",
      OSRM_BASE_URL: "https://osrm.test", OSRM_WALKING_BASE_URL: "https://osrm.test", OSRM_CYCLING_BASE_URL:"https://osrm.test" };
    worker = (await import(new URL("../../dist/server/index.js", import.meta.url))).default;
    const login = await fixture.request("/api/auth/login", { method: "POST", body: { email: "qa@example.invalid", password } });
    assert.equal(login.status, 200, await login.text());
    fixture.cookie = login.headers.get("set-cookie").split(";")[0];
    // Seed runs ONLY on the disposable in-memory DB, to exercise actual startup.
    await fixture.json("/api/admin/bootstrap");
    if (!prepareDatabase) db.prepare(`INSERT INTO memberships (id,organization_id,user_id,role_id,status,created_at,updated_at)
      VALUES ('QA-MEM-2','ORG-002','QA-ADMIN','ORG-002:administrator','active',?,?)`).run(now, now);
    return fixture;
  } catch (error) { fixture.close(); throw error; }
}
