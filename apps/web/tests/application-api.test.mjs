import assert from "node:assert/strict";
import { after, before, beforeEach, afterEach, test } from "node:test";
import { isolatedWorker } from "./helpers/isolated-worker.mjs";

let app;
test("MAP-01 shared settings select OSM without a 2GIS map key and across divisions", async () => {
  app.db.exec("UPDATE system_settings SET travel_matrix_provider='osrm', optimization_engine='pyvrp' WHERE id=1");
  const expected={providerId:'osm',tileUrl:'https://tile.openstreetmap.org/{z}/{x}/{y}.png'};
  assert.deepEqual(await app.json('/api/map-config'),expected);
  assert.deepEqual(await app.json('/api/map-config',{headers:{'X-MMI-Organization':'ORG-002'}}),expected);
  app.db.exec("UPDATE system_settings SET travel_matrix_provider='two_gis' WHERE id=1");
  await app.json('/api/map-config',{},424);
});
before(async () => { app = await isolatedWorker(); });
after(() => app?.close());
beforeEach(t => { app.db.exec("SAVEPOINT scenario");
  // Initial-distribution scenarios start before any work is underway.
  // Busy/paused workers and their estimates are covered by planning-availability.
  if (t.name.startsWith("PLAN-")) app.db.exec("UPDATE work_orders SET status='completed' WHERE status IN ('en_route','in_progress','paused')");
  // Explicit customer windows in this fixture, independent of the old demo's planned times.
  app.db.exec("UPDATE work_orders SET client_window_start = SUBSTR(scheduled_start, 1, 10) || 'T05:00:00.000Z', client_window_end = SUBSTR(scheduled_start, 1, 10) || 'T13:00:00.000Z'"); app.calls.length = 0; app.geocodingFailure = false; });
afterEach(() => { app.db.exec("ROLLBACK TO scenario; RELEASE scenario"); });

const readApis = ["/api/planning/group?date=2026-08-20", "/api/planning/workspace", "/api/planning/group/equipment?date=2026-08-20", "/api/engineers/equipment?workerId=EMP-402", "/api/engineers/availability?workerId=EMP-402", "/api/organization-context", "/api/admin/bootstrap", "/api/admin/skills", "/api/admin/qualifications",
  "/api/admin/work-schedules", "/api/requests", "/api/engineers", "/api/resources", "/api/reports?from=2026-08-01&to=2026-08-31", "/api/map-config", "/api/geocoding?q=Москва"];
const writes = [["/api/planning/group", "POST"], ["/api/planning/group", "PUT"], ["/api/engineers/equipment", "PUT"], ["/api/engineers/availability", "PUT"], ["/api/admin/users", "POST"], ["/api/admin/roles", "PUT"], ["/api/admin/settings", "PUT"],
  ["/api/admin/work-types", "POST"], ["/api/admin/work-schedules", "POST"], ["/api/admin/skills", "POST"],
  ["/api/admin/qualifications", "POST"], ["/api/requests", "POST"], ["/api/engineers", "POST"],
  ["/api/resources", "POST"], ["/api/planning", "POST"], ["/api/planning", "PUT"], ["/api/organization-context", "PUT"]];

test("SEC-01 all desktop API entrypoints reject an anonymous session without external calls", async () => {
  for (const path of readApis) assert.equal((await app.request(path, { cookie: "" })).status, 401, path);
  for (const [path, method] of writes) assert.equal((await app.request(path, { method, body: {}, cookie: "" })).status, 401, path);
  assert.deepEqual(app.calls, []);
});

test("SEC-02 every desktop mutation rejects a cross-origin request before writing", async () => {
  for (const [path, method] of writes) assert.equal((await app.request(path, { method, body: {}, origin: "https://foreign.invalid" })).status, 403, path);
  assert.deepEqual(app.calls, []);
});

test("SEC-03 removing role permissions denies protected reads and writes even with a valid session", async () => {
  app.db.exec("DELETE FROM role_permissions WHERE role_id IN (SELECT role_id FROM memberships WHERE user_id='QA-ADMIN')");
  for (const path of readApis.filter(path=>!["/api/organization-context","/api/map-config","/api/geocoding"].includes(path.split("?")[0]))) assert.equal((await app.request(path)).status, 403, path);
  for (const [path, method] of writes.filter(([path]) => path !== "/api/organization-context")) {
    assert.equal((await app.request(path, { method, body: {} })).status, 403, path);
  }
});

test("WEB-01 every signed-in workspace renders Russian headings from the built Worker", async () => {
  for (const [path, heading] of [["/", "Планирование выездов"], ["/requests", "Заявки"], ["/engineers", "Исполнители"],
    ["/resources", "Ресурсы"], ["/reports", "Отч"], ["/admin", "Администрирование"]]) {
    const response = await app.request(path, { headers: { accept: "text/html" } });
    assert.equal(response.status, 200, path);
    assert.ok((await response.text()).includes(heading), `${path}: ${heading}`);
    assert.match(response.headers.get("cache-control"), /no-store/);
  }
});

test("ORG-01 organization switch uses membership and replaces all scoped collections", async () => {
  const context = await app.json("/api/organization-context");
  assert.deepEqual(context.organizations.map((o) => o.id), ["ORG-001", "ORG-002"]);
  const switched = await app.request("/api/organization-context", { method: "PUT", body: { organizationId: "ORG-002" } });
  assert.equal(switched.status, 200);
  const cookie = `${app.cookie}; ${switched.headers.get("set-cookie").split(";")[0]}`;
  for (const path of ["/api/requests", "/api/engineers", "/api/resources", "/api/admin/work-schedules"]) {
    assert.deepEqual((await app.json(path, { cookie })).items, [], path);
  }
  const second = await app.json("/api/admin/bootstrap", { cookie });
  const first = await app.json("/api/admin/bootstrap");
  for (const key of ['workTypes','skills','qualifications','workCategories','equipmentItems']) assert.deepEqual(second[key],first[key]);
  assert.ok(second.users.every((u) => u.id === "QA-ADMIN"));
  assert.ok((await app.json("/api/requests")).items.length > 3, "original organization's orders are intact");
});

test("ORG-02 cannot switch to an unauthorized or nonexistent organization", async () => {
  for (const organizationId of ["ORG-003", "ORG-MISSING"]) {
    const response = await app.request("/api/organization-context", { method: "PUT", body: { organizationId } });
    assert.equal(response.status, 403);
    assert.equal(response.headers.get("set-cookie"), null);
  }
});

const schedule = () => ({ name: "Тестовый 5/2", active: true, days: Array.from({ length: 7 }, (_, i) => ({
  weekday: i + 1, enabled: i < 5, startTime: i < 5 ? "08:00" : "", endTime: i < 5 ? "17:00" : "",
  breakStart: i < 5 ? "12:00" : "", breakEnd: i < 5 ? "13:00" : "",
})) });

test("SCH-01 creates and edits a seven-day schedule with a break without duplicating days", async () => {
  const { item } = await app.json("/api/admin/work-schedules", { method: "POST", body: schedule() }, 201);
  assert.equal(item.days.length, 7);
  assert.equal(item.days[0].breakStart, "12:00");
  const changed = { ...item, name: "Новый график", days: item.days.map((day) => day.weekday === 1 ? { ...day, startTime: "09:00" } : day) };
  const saved = await app.json("/api/admin/work-schedules", { method: "PUT", body: changed });
  assert.equal(saved.item.id, item.id);
  assert.equal(saved.item.days[0].startTime, "09:00");
  assert.equal(app.db.prepare("SELECT COUNT(*) AS n FROM work_schedule_days WHERE schedule_id = ?").get(item.id).n, 7);
});

test("SCH-02 rejects invalid shift/break ranges, duplicate weekdays and duplicate names", async () => {
  for (const patch of [{ startTime: "18:00", endTime: "08:00" }, { breakStart: "07:00", breakEnd: "08:30" },
    { breakStart: "13:00", breakEnd: "12:00" }, { breakStart: "12:00", breakEnd: "" }, { weekday: 2 }]) {
    const body = schedule(); Object.assign(body.days[0], patch);
    await app.json("/api/admin/work-schedules", { method: "POST", body }, 400);
  }
  await app.json("/api/admin/work-schedules", { method: "POST", body: schedule() }, 201);
  await app.json("/api/admin/work-schedules", { method: "POST", body: schedule() }, 409);
});

const settings = (extra = {}) => ({ timezone: "Europe/Moscow",
  optimizationEngine: "pyvrp", travelMatrixProvider: "osrm", ...extra });

test("CFG-01 system settings are shared across departments while office and timezone stay regional", async () => {
  const otherName = app.db.prepare("SELECT application_name FROM organizations WHERE id = 'ORG-002'").get().application_name;
  const saved = await app.json("/api/admin/settings", { method: "PUT", body: settings() });
  assert.equal(Object.hasOwn(saved.settings, "appName"), false);
  const loaded = await app.json("/api/admin/bootstrap");
  assert.equal(loaded.settings.travelMatrixProvider, "osrm");
  assert.equal(loaded.settings.optimizationEngine, "pyvrp");
  const other = await app.json("/api/admin/bootstrap", {cookie:`${app.cookie}; mmi_organization=ORG-002`});
  assert.equal(Object.hasOwn(other.settings, "appName"), false);
  assert.equal(other.settings.travelMatrixProvider,"osrm");
  assert.equal(other.settings.optimizationEngine,"pyvrp");
  assert.equal(app.db.prepare("SELECT application_name FROM organizations WHERE id = 'ORG-002'").get().application_name, otherName);
  await app.json("/api/admin/settings", { method: "PUT", body: settings({ optimizationEngine: "two_gis_tsp", travelMatrixProvider: "two_gis" }) });
  assert.equal((await app.json("/api/admin/bootstrap", {cookie:`${app.cookie}; mmi_organization=ORG-002`})).settings.optimizationEngine,"two_gis_tsp");
  await app.json("/api/admin/settings", { method: "PUT", body: settings({ optimizationEngine: "two_gis_tsp" }) }, 400);
  await app.json("/api/admin/settings", { method: "PUT", body: settings({ optimizationEngine: "local_greedy" }) }, 400);
  await app.json("/api/admin/settings", { method: "PUT", body: settings({ travelMatrixProvider: "unknown" }) }, 400);
});

test("CFG-02 department and planning saves only change their own settings", async () => {
  const readSystem = () => app.db.prepare("SELECT * FROM system_settings WHERE id=1").get();
  const readDepartments = () => app.db.prepare("SELECT * FROM organizations ORDER BY id").all();
  const systemBefore = readSystem();
  const department = await app.json("/api/admin/settings", { method: "PUT", body: {
    scope: "department", timezone: "Europe/Samara", officeAddress: "Москва, Тестовая, 1",
    optimizationEngine: "invalid", travelMatrixProvider: "invalid",
  } });
  assert.deepEqual(Object.keys(department.settings).sort(), ["officeAddress", "timezone"]);
  assert.equal(department.settings.timezone, "Europe/Samara");
  assert.deepEqual(readSystem(), systemBefore);
  const departmentsBefore = readDepartments();
  app.geocodingFailure = true;
  const planning = await app.json("/api/admin/settings", { method: "PUT", body: {
    scope: "planning", optimizationEngine: "ortools", travelMatrixProvider: "osrm", optimizerPolicy: "emergency_staff/v1",
    timezone: "invalid", officeAddress: "Несохранённый адрес",
  } });
  assert.deepEqual(Object.keys(planning.settings).sort(), ["calculationTimeoutSeconds", "optimizationEngine", "optimizerPolicy", "travelMatrixProvider"]);
  assert.equal(readSystem().optimization_engine, "ortools");
  assert.deepEqual(readDepartments(), departmentsBefore);
  const loaded = await app.json("/api/admin/bootstrap");
  for (const removed of ["appName", "emailAlerts", "weeklyDigest"]) assert.equal(Object.hasOwn(loaded.settings, removed), false);
  await app.json("/api/admin/settings", { method: "PUT", body: { scope: "unknown" } }, 400);
  assert.deepEqual(readDepartments(), departmentsBefore);
});

test("CFG-03 calculation timeout is validated, shared and preserved by legacy settings saves", async () => {
  const payload={scope:'planning',optimizationEngine:'pyvrp',travelMatrixProvider:'osrm',calculationTimeoutSeconds:420};
  assert.equal((await app.json('/api/admin/bootstrap')).settings.calculationTimeoutSeconds,180);
  await app.json('/api/admin/settings',{method:'PUT',body:payload});
  assert.equal((await app.json('/api/admin/bootstrap',{cookie:`${app.cookie}; mmi_organization=ORG-002`})).settings.calculationTimeoutSeconds,420);
  assert.equal((await app.json('/api/planning/workspace')).planningSettings.calculationTimeoutSeconds,420);
  await app.json('/api/admin/settings',{method:'PUT',body:settings()});
  assert.equal((await app.json('/api/admin/bootstrap')).settings.calculationTimeoutSeconds,420);
  for(const invalid of [null,0,29,1801,60.5,'300']) await app.json('/api/admin/settings',{method:'PUT',body:{...payload,calculationTimeoutSeconds:invalid}},400);
  assert.equal((await app.json('/api/admin/bootstrap')).settings.calculationTimeoutSeconds,420);
});

const order = (extra = {}) => ({ work: "Ремонт оборудования", description: "Проверка заявки и русских символов ёЁ", priority: "high",
  status: "new", dateTime: "2026-08-20T10:00", address: "Москва, Тестовая улица, 1", assignee: "", ...extra });

test("REQ-01 creates an order with server-geocoded coordinates and the type's planned duration", async () => {
  app.db.exec("UPDATE work_type_versions SET planned_duration_minutes = 90 WHERE id = 'WORK-001-V1'");
  const { item } = await app.json("/api/requests", { method: "POST", body: order({ point: { lat: 0, lon: 0 } }) }, 201);
  assert.deepEqual(item.point, { lat: 55.76, lon: 37.61 });
  assert.equal(app.db.prepare("SELECT scheduled_end FROM work_orders WHERE id = ?").get(item.id).scheduled_end, "2026-08-20T11:30");
  assert.equal(item.description, order().description);
  assert.ok(app.calls.some((call) => call.includes("/geocode")));
});

test("REQ-02 geocoding failure creates neither a partial order nor a service object", async () => {
  const count = (table) => app.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
  const orders = count("work_orders"), objects = count("service_objects");
  app.geocodingFailure = true;
  const response = await app.request("/api/requests", { method: "POST", body: order() });
  assert.ok(response.status >= 400);
  assert.equal(count("work_orders"), orders);
  assert.equal(count("service_objects"), objects);
});

test("REQ-03 stale revision cannot overwrite a changed order; unchanged address is not geocoded again", async () => {
  const items = (await app.json("/api/requests")).items;
  const item = items.find((value) => value.id === "A-1428");
  await app.json("/api/requests", { method: "PUT", body: { ...item, description: "Первое сохранение" } });
  await app.json("/api/requests", { method: "PUT", body: { ...item, description: "Потерянное обновление" } }, 409);
  assert.equal(app.db.prepare("SELECT description FROM work_orders WHERE id = 'A-1428'").get().description, "Первое сохранение");
  assert.deepEqual(app.calls, []);
});

test("REQ-04 dispatcher cannot pause a new order, resume paused work, or confirm unfinished work", async () => {
  await app.json("/api/requests", { method: "POST", body: order({ status: "paused" }) }, 400);
  const item = (await app.json("/api/requests")).items.find((value) => value.id === "A-1428");
  await app.json("/api/requests", { method: "PUT", body: { ...item, status: "confirmed" } }, 409);
  app.db.exec("UPDATE work_orders SET status = 'paused' WHERE id = 'A-1428'");
  const paused = (await app.json("/api/requests")).items.find((value) => value.id === item.id);
  await app.json("/api/requests", { method: "PUT", body: { ...paused, status: "working" } }, 409);
});

test("REQ-05 foreign order cannot be edited through an organization cookie", async () => {
  const item = (await app.json("/api/requests")).items.find((value) => value.id === "A-1428");
  await app.json("/api/requests", { method: "PUT", body: item, cookie: `${app.cookie}; mmi_organization=ORG-002` }, 404);
});

const resource = (extra = {}) => ({ name: "Тестовый фургон", type: "Фургон", plate: "А123АА", region: "77", status: "available",
  condition: "Исправен", section: "Север", assignment: "Алексей Иванов", vin: "TESTVIN00000000001", notes: "Тест", ...extra });

test("RES-01 resource CRUD preserves assignment and rejects duplicate VIN and foreign IDs", async () => {
  const { item } = await app.json("/api/resources", { method: "POST", body: resource() }, 201);
  assert.equal(item.assignment, "Алексей Иванов");
  await app.json("/api/resources", { method: "POST", body: resource() }, 409);
  await app.json("/api/resources", { method: "PUT", body: { ...item, notes: "Изменено" } });
  assert.equal(app.db.prepare("SELECT notes FROM resources WHERE id = ?").get(item.id).notes, "Изменено");
  await app.json("/api/resources", { method: "PUT", body: item, cookie: `${app.cookie}; mmi_organization=ORG-002` }, 404);
  await app.json("/api/resources", { method: "POST", body: resource({ condition: "service", serviceDate: "", vin: "" }) }, 400);
});

const testUser = (extra = {}) => ({ user: { name: "Тестовый пользователь", email: "new-user@example.invalid", roleId: "executor", status: "active", ...extra },
  password: "isolated-test-password", requirePasswordChange: false });

test("ADM-01 create user, reject duplicate email, revoke session when blocked", async () => {
  const { item } = await app.json("/api/admin/users", { method: "POST", body: testUser() }, 201);
  await app.json("/api/admin/users", { method: "POST", body: testUser() }, 409);
  const login = await app.request("/api/auth/login", { method: "POST", body: { email: item.email, password: testUser().password } });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie").split(";")[0];
  await app.json("/api/admin/users", { method: "PUT", body: { ...testUser({ ...item, status: "blocked" }), password: "" } });
  assert.equal(app.db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?").get(item.id).n, 0);
  await app.json("/api/requests", { cookie }, 401);
});

test("ADM-02 an administrator cannot edit a user belonging only to another organization", async () => {
  const foreign = (await app.json("/api/admin/users", { method: "POST", body: testUser(), cookie: `${app.cookie}; mmi_organization=ORG-002` }, 201)).item;
  // Simulate externally administered membership IDs (not tied to API ID naming).
  app.db.prepare("UPDATE memberships SET id = 'FOREIGN-MEMBERSHIP' WHERE user_id = ?").run(foreign.id);
  app.db.exec("DELETE FROM memberships WHERE user_id = 'QA-ADMIN' AND organization_id = 'ORG-002'");
  const response = await app.request("/api/admin/users", { method: "PUT", body: { ...testUser({ ...foreign, name: "Чужая правка" }), password: "" } });
  assert.ok([403, 404].includes(response.status), `foreign user update must be denied, received ${response.status}`);
  assert.equal(app.db.prepare("SELECT display_name FROM users WHERE id = ?").get(foreign.id).display_name, foreign.name);
});

async function mobile() {
  // Only the in-memory demo worker receives a fixture password; no live account.
  app.db.exec(`UPDATE users SET password_salt=(SELECT password_salt FROM users WHERE id='QA-ADMIN'),
    password_hash=(SELECT password_hash FROM users WHERE id='QA-ADMIN'), password_iterations=1000,
    must_change_password=0 WHERE id='USR-402'`);
  const email = app.db.prepare("SELECT email FROM users WHERE id='USR-402'").get().email;
  const { token } = await app.json("/api/mobile/v1/auth/login", { method: "POST", body: { email, password: "isolated-test-password" } });
  const headers = { authorization: `Bearer ${token}` };
  return {
    token, headers,
    state: () => app.json("/api/mobile/v1/state?date=2026-08-20", { headers, cookie: "" }),
    command: (body, status = 200) => app.json("/api/mobile/v1/commands", { method: "POST", headers, cookie: "", body: { operationId: crypto.randomUUID(), ...body } }, status),
  };
}

test("MOB-01 API health, mobile session isolation and logout", async () => {
  assert.equal((await app.json("/api/mobile/v1/health", { cookie: "" })).protocol, 1);
  await app.json("/api/mobile/v1/state", {}, 401); // Desktop cookie is not a bearer session.
  const client = await mobile();
  const state = await client.state();
  assert.ok(state.visits.some((visit) => visit.id === "A-1428"));
  assert.ok(state.visits.every((visit) => !visit.id.startsWith("B-")));
  await app.json("/api/mobile/v1/auth/logout", { method: "POST", headers: client.headers, body: {} });
  await app.json("/api/mobile/v1/state", { headers: client.headers }, 401);
});

test("MOB-02 pause from mobile appears in dispatcher, duplicate delivery is idempotent and resume works", async () => {
  const client = await mobile();
  // Do not let the separately seeded active visit block this isolated lifecycle.
  app.db.exec("UPDATE work_orders SET status='assigned' WHERE id='ORD-9020'");
  const visit = (await client.state()).visits.find((v) => v.id === "A-1428");
  const operationId = crypto.randomUUID();
  const problem = { operationId, action: "problem", visitId: visit.id, revision: visit.revision,
    reason: "Нет доступа на объект", details: "Закрыта дверь, диспетчер уведомлён" };
  await client.command(problem);
  assert.equal((await client.command(problem)).replayed, true);
  const changed = (await app.json("/api/requests")).items.find((v) => v.id === visit.id);
  assert.equal(changed.status, "paused");
  const issue = app.db.prepare("SELECT * FROM mobile_issues WHERE work_order_id=?").all(visit.id);
  assert.equal(issue.length, 1);
  assert.equal(issue[0].detail, problem.details);
  assert.ok(Number.isFinite(Date.parse(issue[0].created_at)));
  const paused = (await client.state()).visits.find((v) => v.id === visit.id);
  await client.command({ action: "status", visitId: visit.id, revision: paused.revision, status: "in_progress" });
  assert.equal((await app.json("/api/requests")).items.find((v) => v.id === visit.id).status, "working");
});

test("MOB-03 stale mobile command and foreign visit are rejected without partial writes", async () => {
  const client = await mobile();
  const visit = (await client.state()).visits.find((v) => v.id === "A-1428");
  app.db.exec("UPDATE work_orders SET description='Правка диспетчера' WHERE id='A-1428'");
  const problem = { action: "problem", visitId: visit.id, revision: visit.revision, reason: "Проблема", details: "Нет доступа" };
  const conflict = await client.command(problem, 409);
  assert.equal(conflict.code, "revision_conflict");
  await client.command({ ...problem, visitId: "B-092" }, 404);
  assert.equal(app.db.prepare("SELECT COUNT(*) AS n FROM mobile_issues").get().n, 0);
});

async function recalculate() {
  await app.json("/api/admin/settings", { method: "PUT", body: settings() });
  return (await app.json("/api/planning", { method: "POST", body: { serviceDate: "2026-08-20" } }, 201)).result;
}

test("PLAN-01 recalculate creates only a draft; publish updates orders, resources and load", async () => {
  const beforeOrders = app.db.prepare("SELECT * FROM work_orders ORDER BY id").all();
  const beforeWorkers = app.db.prepare("SELECT id,load_percent FROM workers ORDER BY id").all();
  const draft = await recalculate();
  assert.equal(app.db.prepare("SELECT status FROM route_plans WHERE id = ?").get(draft.planId).status, "draft");
  assert.deepEqual(app.db.prepare("SELECT * FROM work_orders ORDER BY id").all(), beforeOrders);
  assert.deepEqual(app.db.prepare("SELECT id,load_percent FROM workers ORDER BY id").all(), beforeWorkers);
  assert.ok(draft.routes.length > 0);
  const published = await app.json("/api/planning", { method: "PUT", body: { planId: draft.planId } });
  assert.equal(published.status, "published");
  const stops = app.db.prepare("SELECT * FROM route_stops WHERE route_plan_id = ?").all(draft.planId);
  for (const stop of stops) {
    const saved = app.db.prepare("SELECT * FROM work_orders WHERE id = ?").get(stop.work_order_id);
    assert.equal(saved.assignee_worker_id, stop.worker_id);
    assert.equal(saved.status, "assigned");
    assert.ok(saved.revision > beforeOrders.find((o) => o.id === saved.id).revision);
  }
  assert.ok((await app.json("/api/resources")).items.some((r) => r.plannedJobs > 0));
  assert.notDeepEqual(app.db.prepare("SELECT id,load_percent FROM workers ORDER BY id").all(), beforeWorkers);
  assert.equal(app.db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE entity_id = ? AND action = 'published'").get(draft.planId).n, 1);
  await app.json("/api/planning", { method: "PUT", body: { planId: draft.planId } }, 409);
});

test("PLAN-02 refuses empty dates and unauthorized publication; a non-working day leaves jobs unassigned with reasons", async () => {
  await app.json("/api/planning", { method: "POST", body: { serviceDate: "bad-date" } }, 400);
  await app.json("/api/planning", { method: "POST", body: { serviceDate: "2026-08-21" } }, 404);
  const closed = await app.json("/api/planning", { method: "POST", body: { serviceDate: "2026-08-23" } }, 201);
  assert.equal(closed.result.metrics.plannedJobs,0);
  assert.ok(closed.result.unassigned.every(item=>item.detail.length>0));
  const draft = await recalculate();
  await app.json("/api/planning", { method: "PUT", body: { planId: draft.planId }, cookie: `${app.cookie}; mmi_organization=ORG-002` }, 404);
});

test("PLAN-03 new recalculation archives the previous draft; started work blocks publication", async () => {
  const old = await recalculate();
  const latest = await recalculate();
  await app.json("/api/planning", { method: "PUT", body: { planId: old.planId } }, 409);
  app.db.prepare("UPDATE work_orders SET status = 'in_progress' WHERE id = (SELECT work_order_id FROM route_stops WHERE route_plan_id = ? LIMIT 1)").run(latest.planId);
  await app.json("/api/planning", { method: "PUT", body: { planId: latest.planId } }, 409);
  assert.equal(app.db.prepare("SELECT status FROM route_plans WHERE id = ?").get(latest.planId).status, "draft");
});

test("PLAN-04 changed scheduled time after recalculation requires a new draft before publication", async () => {
  const draft = await recalculate();
  app.db.prepare("UPDATE work_orders SET scheduled_start = '2026-08-20T16:00', scheduled_end = '2026-08-20T17:00' WHERE id = (SELECT work_order_id FROM route_stops WHERE route_plan_id = ? LIMIT 1)").run(draft.planId);
  await app.json("/api/planning", { method: "PUT", body: { planId: draft.planId } }, 409);
});

test("DB-01 migration chain and seeded references satisfy SQLite foreign-key checks", () => {
  assert.deepEqual(app.db.prepare("PRAGMA foreign_key_check").all(), []);
  assert.equal(app.db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
});

test('REQ-09 public order numbers are numeric and allocated independently of internal IDs', async () => {
  app.db.exec("UPDATE work_orders SET number='54964' WHERE id='A-1428'");
  const results=await Promise.all([1,2].map(i=>app.json('/api/requests',{method:'POST',body:order({description:`Новая заявка ${i}`})},201)));
  assert.deepEqual(results.map(({item})=>Number(item.number)).sort((a,b)=>a-b),[54965,54966]);
  for(const {item} of results) { assert.match(item.number,/^\d+$/);assert.notEqual(item.id,item.number); }
  const requests=await app.json('/api/requests');assert.equal(requests.items.find(i=>i.id==='A-1428').number,'54964');
});
