import assert from "node:assert/strict";
import {before,after,beforeEach,afterEach,test} from "node:test";
import {isolatedWorker} from "./helpers/isolated-worker.mjs";
import {commonScenario} from "./helpers/common-plan.mjs";
let app;
before(async()=>{app=await isolatedWorker();});after(()=>app?.close());
beforeEach(()=>{app.db.exec("SAVEPOINT assigned_map");commonScenario(app);app.calls.length=0;});
afterEach(()=>{app.osrmHandler=null;app.db.exec("ROLLBACK TO assigned_map; RELEASE assigned_map");});

test("ASSIGNED-MAP-01 reads actual assignments in time order without optimization or writes",async()=>{
  app.db.exec("UPDATE work_orders SET status='assigned',assignee_worker_id='COMMON-1-W' WHERE id='COMMON-1-J'");
  const baseline=app.db.prepare("SELECT * FROM work_orders ORDER BY id").all();
  const plans=app.db.prepare("SELECT * FROM route_plans").all();
  const result=await app.json("/api/planning/assigned-routes?date=2026-08-20");
  assert.equal(result.routes.length,1);
  assert.equal(result.routes[0].agentId,"COMMON-1-W");
  assert.deepEqual(result.routes[0].visits.map(v=>v.jobId),["COMMON-1-J"]);
  assert.equal(result.routes[0].geometrySource,"osrm");
  assert.ok(result.routes[0].geometry.length>=2);
  assert.ok(app.calls.length>0);
  assert.ok(app.calls.every(url=>url.startsWith("osrm.test/route/v1/driving/")),JSON.stringify(app.calls));
  assert.deepEqual(app.db.prepare("SELECT * FROM work_orders ORDER BY id").all(),baseline);
  assert.deepEqual(app.db.prepare("SELECT * FROM route_plans").all(),plans);
  assert.deepEqual((await app.json("/api/planning/assigned-routes?date=2026-08-21")).routes,[]);
  app.db.exec("UPDATE work_orders SET status='new' WHERE id='COMMON-1-J'");
  assert.deepEqual((await app.json("/api/planning/assigned-routes?date=2026-08-20")).routes,[]);
});

test("ASSIGNED-MAP-02 unavailable roads retain actual markers and never fabricate lines",async()=>{
  app.db.exec("UPDATE work_orders SET status='assigned',assignee_worker_id='COMMON-1-W' WHERE id='COMMON-1-J'");
  app.osrmHandler=()=>{throw new Error("offline");};
  const route=(await app.json("/api/planning/assigned-routes?date=2026-08-20")).routes[0];
  assert.equal(route.visits[0].label,"Заявка COMMON-1");
  assert.equal(route.geometrySource,"fallback");assert.deepEqual(route.geometry,[]);
  await app.json("/api/planning/assigned-routes?date=2026-02-30",{},400);
});


test("ASSIGNED-MAP-03 preserves appointment order, isolates authorized departments and skips paused jobs",async()=>{
  app.db.exec(`UPDATE work_orders SET status='assigned',assignee_worker_id=CASE id WHEN 'COMMON-1-J' THEN 'COMMON-1-W' ELSE 'COMMON-2-W' END WHERE id IN ('COMMON-1-J','COMMON-2-J');
    INSERT INTO work_orders(id,organization_id,number,work_type_version_id,created_by_user_id,status,scheduled_start,scheduled_end,scheduling_timezone,address_snapshot,latitude_snapshot,longitude_snapshot,assignee_worker_id,created_at,updated_at)
    SELECT 'EARLY','ORG-001','EARLY',work_type_version_id,created_by_user_id,'assigned','2026-08-20T10:00','2026-08-20T11:00',scheduling_timezone,address_snapshot,55.77,37.63,'COMMON-1-W',created_at,updated_at FROM work_orders WHERE id='COMMON-1-J';`);
  const routes=(await app.json("/api/planning/assigned-routes?date=2026-08-20")).routes;
  assert.equal(routes.length,2);
  assert.deepEqual(routes.find(r=>r.agentId==='COMMON-1-W').visits.map(v=>v.jobId),['EARLY','COMMON-1-J']);
  app.db.exec("DELETE FROM memberships WHERE user_id='QA-ADMIN' AND organization_id='ORG-002'; UPDATE work_orders SET status='paused' WHERE id='EARLY'");
  const scoped=(await app.json("/api/planning/assigned-routes?date=2026-08-20")).routes;
  assert.equal(scoped.length,1);assert.deepEqual(scoped[0].visits.map(v=>v.jobId),['COMMON-1-J']);
});
