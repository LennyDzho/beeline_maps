import assert from "node:assert/strict";
import { before, after, beforeEach, afterEach, test } from "node:test";
import { isolatedWorker } from "./helpers/isolated-worker.mjs";
let app;
before(async () => { app = await isolatedWorker(); });
after(() => app?.close());
beforeEach(() => app.db.exec("SAVEPOINT manual_schedule"));
afterEach(() => app.db.exec("ROLLBACK TO manual_schedule; RELEASE manual_schedule"));

async function setup() {
  const data = await app.json("/api/requests");
  const source = data.items.find(item => item.assigneeId && item.status === "assigned");
  assert.ok(source);
  const create = async (dateTime, status="assigned") => (await app.json("/api/requests", { method: "POST", body: {
    work: source.work, description: "Проверка ручного назначения", priority: "medium", status, dateTime, address: source.address,
    assignee: source.assignee, assigneeId: source.assigneeId, clientWindowStart: "2026-08-26T00:00", clientWindowEnd: "2026-08-27T00:00",
  } }, 201)).item;
  return { source, create };
}

test("MANUAL-01 assignment and later time/window changes have persistent concise reasons", async () => {
  const { create } = await setup();
  const item = await create("2026-08-26T10:00");
  assert.match(item.schedulingChanges[0].reason, /Назначена вручную/);
  const changed = (await app.json("/api/requests", { method: "PUT", body: { ...item, dateTime: "2026-08-26T11:00", clientWindowEnd: "2026-08-26T15:00" } })).item;
  assert.equal(changed.schedulingChanges.length, 2);
  assert.match(changed.schedulingChanges[0].reason, /плановое время/);
  assert.match(changed.schedulingChanges[0].reason, /клиентское окно/);
  const unchanged = (await app.json("/api/requests", { method: "PUT", body: { ...changed, description: "Только описание" } })).item;
  assert.equal(unchanged.schedulingChanges.length, 2);
  const removed = (await app.json("/api/requests", { method: "PUT", body: { ...unchanged, assignee: "", assigneeId: "", status: "new" } })).item;
  assert.match(removed.schedulingChanges[0].reason, /снято вручную/);
  assert.equal(removed.schedulingChanges[0].before.workerId, item.assigneeId);
  assert.equal(removed.schedulingChanges[0].after.workerId, null);
});

test("MANUAL-02 overlap is visible on both orders and touching intervals are not conflicts", async () => {
  const { create } = await setup();
  const a = await create("2026-08-26T10:00");
  const b = await create("2026-08-26T10:10");
  assert.equal(b.scheduleConflicts[0].requestId, a.id);
  const rows = (await app.json("/api/requests")).items;
  assert.equal(rows.find(item => item.id===a.id).scheduleConflicts[0].requestId, b.id);
  const end = app.db.prepare("SELECT scheduled_end FROM work_orders WHERE id=?").get(a.id).scheduled_end;
  const moved = (await app.json("/api/requests", { method: "PUT", body: { ...b, dateTime: end } })).item;
  assert.deepEqual(moved.scheduleConflicts, []);
  const cancelled = (await app.json("/api/requests", { method: "PUT", body: { ...moved, dateTime: a.dateTime, status: "cancelled" } })).item;
  assert.equal(cancelled.status, "cancelled");
  assert.deepEqual(cancelled.scheduleConflicts, []);
});

test("MANUAL-03 overlaps compare instants across regions and a stale edit cannot append a false change", async () => {
  const { create } = await setup();
  const a = await create("2026-08-26T10:00");
  const b = await create("2026-08-26T12:00");
  app.db.prepare("UPDATE work_orders SET scheduling_timezone='Asia/Yekaterinburg' WHERE id=?").run(b.id);
  const rows = (await app.json("/api/requests")).items;
  assert.equal(rows.find(item => item.id === a.id).scheduleConflicts[0].requestId, b.id);
  const count = app.db.prepare("SELECT COUNT(*) n FROM audit_events WHERE action='scheduling_changed'").get().n;
  await app.json("/api/requests", { method: "PUT", body: { ...b, dateTime: "2026-08-26T15:00" } }, 409);
  assert.equal(app.db.prepare("SELECT COUNT(*) n FROM audit_events WHERE action='scheduling_changed'").get().n, count);
});
