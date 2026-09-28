import assert from "node:assert/strict";
import { before, after, beforeEach, afterEach, test } from "node:test";
import { isolatedWorker } from "./helpers/isolated-worker.mjs";

let app;
before(async () => { app = await isolatedWorker(); });
after(() => app?.close());
beforeEach(() => app.db.exec("SAVEPOINT plan_comparison"));
afterEach(() => app.db.exec("ROLLBACK TO plan_comparison; RELEASE plan_comparison"));

async function setup() {
  app.db.exec(`UPDATE work_orders SET status='cancelled';
    UPDATE work_orders SET status='assigned',scheduling_timezone='Europe/Moscow',client_window_start='2026-08-20T09:00:00+03:00',client_window_end='2026-08-20T17:00:00+03:00' WHERE id='A-1428';
    UPDATE workers SET active=0;
    UPDATE workers SET active=1,shift_status='on_shift',transport_mode='car',work_schedule_id=(SELECT work_schedule_id FROM workers WHERE id='EMP-402') WHERE id='EMP-390';
    INSERT OR IGNORE INTO worker_skills (worker_id,skill_id) SELECT 'EMP-390',skill_id FROM worker_skills WHERE worker_id='EMP-402';
    INSERT OR IGNORE INTO worker_qualifications (worker_id,qualification_id,status) SELECT 'EMP-390',qualification_id,'valid' FROM worker_qualifications WHERE worker_id='EMP-402';`);
  await app.json("/api/admin/settings", { method: "PUT", body: { appName: "Марш!", timezone: "Europe/Moscow", emailAlerts: true, weeklyDigest: false, optimizationEngine: "pyvrp", travelMatrixProvider: "osrm" } });
}

test("PLAN-01 saved draft retains both sides of reassignment and publication records the short reason", async () => {
  await setup();
  const { result } = await app.json("/api/planning", { method: "POST", body: { serviceDate: "2026-08-20" } }, 201);
  assert.equal(result.changes.length, 1);
  assert.equal(result.changes[0].before.workerId, "EMP-402");
  assert.equal(result.changes[0].after.workerId, "EMP-390");
  assert.match(result.changes[0].reason, /недоступен/);
  assert.match(result.routes[0].visits[0].change.label, /Перенесена с/);
  const loaded = await app.json("/api/planning?date=2026-08-20");
  assert.deepEqual(loaded.result, result); assert.equal(loaded.outdated, false);
  await app.json("/api/planning", { method: "PUT", body: { planId: result.planId } });
  const published = await app.json("/api/planning?date=2026-08-20");
  assert.equal(published.result.status, "published");
  assert.deepEqual(published.result.changes, result.changes);
  const request = (await app.json("/api/requests")).items.find(item => item.id === "A-1428");
  const event = request.schedulingChanges.find(event => event.source === "planning");
  assert.equal(event.reason, result.changes[0].reason); assert.equal(event.before.workerId, "EMP-402"); assert.equal(event.after.workerId, "EMP-390");
  app.db.exec("UPDATE work_orders SET scheduled_start='2026-08-20T16:00' WHERE id='A-1428'");
  assert.deepEqual(await app.json("/api/planning?date=2026-08-20"), { result: null, outdated: true });
});

test("PLAN-02 the first assignment is silent; unassignment keeps an explicit reason after reloading", async () => {
  await setup();
  app.db.exec("UPDATE work_orders SET status='new',assignee_worker_id=NULL WHERE id='A-1428'");
  let { result } = await app.json("/api/planning", { method: "POST", body: { serviceDate: "2026-08-20" } }, 201);
  assert.deepEqual(result.changes, []); assert.equal(result.routes[0].visits[0].change, undefined);
  await app.json("/api/planning", { method: "PUT", body: { planId: result.planId } });
  assert.equal(app.db.prepare("SELECT COUNT(*) n FROM audit_events WHERE entity_id='A-1428' AND action='scheduling_changed'").get().n, 0);
  app.db.exec("UPDATE workers SET shift_status='off_shift' WHERE id='EMP-390'");
  ({ result } = await app.json("/api/planning", { method: "POST", body: { serviceDate: "2026-08-20" } }, 201));
  assert.equal(result.unassigned.length, 1); assert.equal(result.changes[0].after.workerId, null);
  assert.equal(result.changes[0].reason, result.unassigned[0].detail);
  await app.json("/api/planning", { method: "PUT", body: { planId: result.planId } });
  assert.deepEqual((await app.json("/api/planning?date=2026-08-20")).result.unassigned, result.unassigned);
  assert.equal(app.db.prepare("SELECT assignee_worker_id FROM work_orders WHERE id='A-1428'").get().assignee_worker_id, null);
});

test("PLAN-03 another division cannot read the saved comparison", async () => {
  await setup();
  await app.json("/api/planning", { method: "POST", body: { serviceDate: "2026-08-20" } }, 201);
  assert.equal((await app.json("/api/planning?date=2026-08-20", { cookie: `${app.cookie}; mmi_organization=ORG-002` })).result, null);
  await app.json("/api/planning?date=2026-08-20", { cookie: "" }, 401);
});
