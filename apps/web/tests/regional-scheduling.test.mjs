import assert from "node:assert/strict";
import { after, before, beforeEach, afterEach, test } from "node:test";
import { isolatedWorker } from "./helpers/isolated-worker.mjs";

let app;
before(async () => { app = await isolatedWorker(); });
after(() => app?.close());
beforeEach(() => { app.db.exec("SAVEPOINT scenario"); app.calls.length = 0; app.geocodingFailure = false; });
afterEach(() => { app.db.exec("ROLLBACK TO scenario; RELEASE scenario"); });
const settings = extra => ({ appName: "Марш!", timezone: "Europe/Moscow", emailAlerts: true, weeklyDigest: false,
  optimizationEngine: "pyvrp", travelMatrixProvider: "osrm", ...extra });
const order = extra => ({ work: "Ремонт оборудования", description: "Региональный тест", priority: "medium", status: "new",
  dateTime: "2026-08-20T10:00", address: "Москва, Тестовая, 1, кв. 12", buildingAddress: "Москва, Тестовая, 1",
  apartment: "12А", entrance: "2Б", intercom: "12#К", assignee: "", clientWindowStart: "2026-08-20T09:00", clientWindowEnd: "2026-08-20T11:00", ...extra });

test("client window and access details survive a planned-time edit and an older client's omitted fields", async () => {
  const { item } = await app.json("/api/requests", { method: "POST", body: order() }, 201);
  assert.equal(item.clientWindowStart, "2026-08-20T09:00");
  assert.equal(item.schedulingTimezone, "Europe/Moscow");
  const saved = app.db.prepare("SELECT * FROM work_orders WHERE id=?").get(item.id);
  assert.equal(saved.client_window_start, "2026-08-20T06:00:00.000Z");
  app.geocodingFailure = true;
  const legacy = { ...item, dateTime: "2026-08-20T10:30", description: "Исправление плана" };
  for (const key of ["clientWindowStart", "clientWindowEnd", "buildingAddress", "apartment", "entrance", "intercom"]) delete legacy[key];
  const updated = (await app.json("/api/requests", { method: "PUT", body: legacy })).item;
  assert.equal(updated.clientWindowStart, item.clientWindowStart);
  assert.equal(updated.clientWindowEnd, item.clientWindowEnd);
  assert.equal(updated.apartment, "12А"); assert.equal(updated.entrance, "2Б"); assert.equal(updated.intercom, "12#К");
  assert.equal(updated.buildingAddress, item.buildingAddress);
  assert.equal(updated.dateTime, "2026-08-20T10:30");
});

test("bad or one-sided client windows and invalid calendar dates leave no partial rows", async () => {
  const count = app.db.prepare("SELECT COUNT(*) n FROM work_orders").get().n;
  for (const extra of [{ clientWindowEnd: "" }, { clientWindowStart: "2026-08-20T12:00" },
    { clientWindowStart: "2026-02-30T10:00" }, { dateTime: "2026-08-32T10:00" }, { apartment: 12 }]) {
    await app.json("/api/requests", { method: "POST", body: order(extra) }, 400);
  }
  assert.equal(app.db.prepare("SELECT COUNT(*) n FROM work_orders").get().n, count);
  assert.deepEqual(app.calls, []);
});

test("department zone change preserves legacy appointments and sets the region of new appointments", async () => {
  const before = app.db.prepare("SELECT scheduled_start FROM work_orders WHERE id='A-1428'").get().scheduled_start;
  await app.json("/api/admin/settings", { method: "PUT", body: settings({ timezone: "Asia/Yekaterinburg" }) });
  const existing = (await app.json("/api/requests")).items.find(item => item.id === "A-1428");
  assert.equal(existing.schedulingTimezone, "Europe/Moscow"); assert.equal(existing.dateTime, before);
  const { item } = await app.json("/api/requests", { method: "POST", body: order() }, 201);
  assert.equal(item.schedulingTimezone, "Asia/Yekaterinburg");
  assert.equal(app.db.prepare("SELECT client_window_start FROM work_orders WHERE id=?").get(item.id).client_window_start, "2026-08-20T04:00:00.000Z");
});

test("worker can inherit office start, use a regional shift, and cannot silently replace an invalid own start", async () => {
  await app.json("/api/admin/settings", { method: "PUT", body: settings({ officeAddress: "Москва, Офис, 10" }) });
  const worker = (await app.json("/api/engineers")).items.find(item => item.id === "EMP-402");
  const { item } = await app.json("/api/engineers", { method: "PUT", body: { ...worker, startAddress: "", startPoint: null, timezone: "Asia/Yekaterinburg" } });
  assert.equal(item.effectiveTimezone, "Asia/Yekaterinburg"); assert.equal(item.startPoint, null);
  await app.json("/api/engineers", { method: "PUT", body: { ...item, startAddress: "Неверный адрес", startPoint: null } }, 400);
  await app.json("/api/engineers", { method: "PUT", body: { ...item, timezone: "Invalid/Zone" } }, 400);
  app.db.exec("UPDATE workers SET active=0 WHERE id <> 'EMP-402'; UPDATE work_orders SET status='cancelled'");
  const job = (await app.json("/api/requests", { method: "POST", body: order({ clientWindowStart: "2026-08-20T07:00", clientWindowEnd: "2026-08-20T07:00" }) }, 201)).item;
  const result = (await app.json("/api/planning", { method: "POST", body: { serviceDate: "2026-08-20" } }, 201)).result;
  assert.equal(result.routes[0].shiftStartAt, "2026-08-20T03:00:00.000Z");
  assert.deepEqual(result.routes[0].startPoint, { lat: 55.76, lon: 37.61 });
  const stop = app.db.prepare("SELECT * FROM route_stops WHERE route_plan_id=? AND work_order_id=?").get(result.planId, job.id);
  assert.equal(stop.planned_start, "2026-08-20T04:00:00.000Z");
  assert.ok(stop.planned_end > stop.planned_start); // Window limits START; finish may be later.
  await app.json("/api/planning", { method: "PUT", body: { planId: result.planId } });
  const published = (await app.json("/api/requests")).items.find(item => item.id === job.id);
  assert.equal(published.dateTime, "2026-08-20T07:00");
  assert.equal(published.clientWindowStart, job.clientWindowStart); assert.equal(published.clientWindowEnd, job.clientWindowEnd);
});

test("unspecified window stays unknown and produces a dispatcher-readable reason", async () => {
  await app.json("/api/admin/settings", { method: "PUT", body: settings() });
  const result = (await app.json("/api/planning", { method: "POST", body: { serviceDate: "2026-08-20" } }, 201)).result;
  assert.equal(result.routes.length, 0);
  assert.ok(result.unassigned.length > 0);
  assert.ok(result.unassigned.every(item => item.reason === "missing_client_window" && /клиентское окно/u.test(item.detail)));
});

test("a worker or customer-window change invalidates publication; a racing update rolls the entire publication back", async () => {
  await app.json("/api/admin/settings", { method: "PUT", body: settings() });
  await app.json("/api/requests", { method: "POST", body: order() }, 201);
  const calculate = async () => (await app.json("/api/planning", { method: "POST", body: { serviceDate: "2026-08-20" } }, 201)).result;
  const first = await calculate();
  app.db.exec("UPDATE workers SET timezone='Asia/Yekaterinburg' WHERE id='EMP-402'");
  await app.json("/api/planning", { method: "PUT", body: { planId: first.planId } }, 409);
  const second = await calculate();
  const batch = app.database.batch;
  let raced = false;
  app.database.batch = async statements => {
    if (!raced) { raced = true; app.db.exec("UPDATE work_orders SET description='Одновременная правка' WHERE id='A-1428'"); }
    return batch.call(app.database, statements);
  };
  try { await app.json("/api/planning", { method: "PUT", body: { planId: second.planId } }, 409); }
  finally { app.database.batch = batch; }
  assert.equal(raced, true);
  assert.equal(app.db.prepare("SELECT status FROM route_plans WHERE id=?").get(second.planId).status, "draft");
  assert.equal(app.db.prepare("SELECT COUNT(*) n FROM audit_events WHERE action='published' AND entity_id=?").get(second.planId).n, 0);
  assert.equal(app.db.prepare("SELECT description FROM work_orders WHERE id='A-1428'").get().description, "Одновременная правка");
});
