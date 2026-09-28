import assert from "node:assert/strict";
import { before,after,beforeEach,afterEach,test } from "node:test";
import { isolatedWorker } from "./helpers/isolated-worker.mjs";

let app;
before(async()=>{app=await isolatedWorker();});
after(()=>app?.close());
beforeEach(()=>app.db.exec("SAVEPOINT availability_case"));
afterEach(()=>app.db.exec("ROLLBACK TO availability_case; RELEASE availability_case"));
const calculate=(eventAt="2026-08-20T08:00:00Z")=>app.json("/api/planning",{method:"POST",body:{serviceDate:"2026-08-20",eventAt}},201).then(r=>r.result);
const availability=()=>app.json("/api/engineers/availability?workerId=EMP-402");
async function saveAvailability(extra={}) {
  const current=await availability();
  return app.json("/api/engineers/availability",{method:"PUT",body:{workerId:"EMP-402",activityRevision:current.activityRevision,
    availableAt:"2026-08-20T12:00",address:"Москва, Тестовая, 1",...extra}});
}
async function prepare(status="in_progress") {
  app.db.exec("UPDATE work_orders SET status='cancelled'; UPDATE workers SET active=0 WHERE id<>'EMP-402'");
  await app.json("/api/admin/settings",{method:"PUT",body:{appName:"Марш!",timezone:"Europe/Moscow",emailAlerts:true,weeklyDigest:false,optimizationEngine:"pyvrp",travelMatrixProvider:"osrm"}});
  const create=async assigned=>(await app.json("/api/requests",{method:"POST",body:{work:"Ремонт оборудования",description:"Доступность",priority:"high",status:assigned?"assigned":"new",
    dateTime:"2026-08-20T10:00",address:"Москва, Тестовая, 1",assignee:assigned?"Алексей Иванов":"",assigneeId:assigned?"EMP-402":undefined,
    clientWindowStart:"2026-08-20T09:00",clientWindowEnd:"2026-08-20T17:00"}},201)).item;
  const protectedJob=await create(true),queued=await create(false);
  app.db.prepare("UPDATE work_orders SET status=? WHERE id=?").run(status,protectedJob.id);
  return {protectedJob,queued};
}

test("AVAIL-01 unknown busy availability cannot be reused; an explicit estimate reserves time and changes the route origin",async()=>{
  const {protectedJob,queued}=await prepare();
  const before=app.db.prepare("SELECT status,scheduled_start,scheduled_end,assignee_worker_id FROM work_orders WHERE id=?").get(protectedJob.id);
  const unknown=await calculate();
  assert.equal(unknown.routes.length,0);
  assert.deepEqual(unknown.protectedJobIds,[protectedJob.id]);
  assert.equal(unknown.metrics.engineersUsed,1,"the protected worker is already used even without a tail route");
  assert.equal(unknown.unassigned[0].jobId,queued.id);
  assert.match(unknown.unassigned[0].detail,/освобождения/);
  assert.ok(unknown.warnings.some(w=>w.includes(protectedJob.id.replace('A-','')) || w.includes('защищённые заявки')));
  const saved=await saveAvailability();
  assert.equal(saved.estimate.stale,false);
  const result=await calculate();
  assert.equal(result.metrics.plannedJobs,1);
  assert.equal(result.routes[0].shiftStartAt,"2026-08-20T10:00:00.000Z","12:00 release is followed by the scheduled 12:00–13:00 break");
  assert.deepEqual(result.routes[0].startPoint,{lat:55.76,lon:37.61});
  assert.equal(result.routes[0].visits[0].serviceStartAt,"2026-08-20T10:00:00.000Z",
    "the release point and queued job share coordinates; no fictitious five-minute drive is needed");
  await app.json("/api/planning",{method:"PUT",body:{planId:result.planId}});
  assert.deepEqual(app.db.prepare("SELECT status,scheduled_start,scheduled_end,assignee_worker_id FROM work_orders WHERE id=?").get(protectedJob.id),before);
  assert.equal((await availability()).estimate.stale,false,"publication load metrics must not invalidate the estimate");
});

test("AVAIL-02 paused work needs an estimate; later status change invalidates both estimate and calculated draft",async()=>{
  const {protectedJob}=await prepare("paused");
  assert.equal((await calculate()).metrics.plannedJobs,0);
  await saveAvailability();
  const plan=await calculate();
  app.db.prepare("UPDATE work_orders SET status='in_progress' WHERE id=?").run(protectedJob.id);
  assert.equal((await availability()).estimate.stale,true);
  await app.json("/api/planning",{method:"PUT",body:{planId:plan.planId}},409);
  assert.equal((await calculate()).metrics.plannedJobs,0);
});

test("AVAIL-03 changing availability during calculation/publishing invalidates the snapshot; a racing status cannot save an old estimate",async()=>{
  const {protectedJob}=await prepare("en_route");
  await saveAvailability();
  const plan=await calculate();
  await saveAvailability({availableAt:"2026-08-20T13:00"});
  await app.json("/api/planning",{method:"PUT",body:{planId:plan.planId}},409);
  const current=await availability(),batch=app.database.batch;
  let raced=false;
  app.database.batch=async statements=>{
    if(!raced){raced=true;app.db.prepare("UPDATE work_orders SET status='in_progress' WHERE id=?").run(protectedJob.id);}
    return batch.call(app.database,statements);
  };
  try { await app.json("/api/engineers/availability",{method:"PUT",body:{workerId:"EMP-402",activityRevision:current.activityRevision,availableAt:"2026-08-20T14:00",address:"Москва, Тестовая, 1"}},409); }
  finally {app.database.batch=batch;}
  assert.equal((await availability()).estimate.availableAt,"2026-08-20T13:00");
});

test("AVAIL-04 remaining day starts at its event time and last completed address, with strict regional dates and scoped access",async()=>{
  const {protectedJob}=await prepare("completed");
  app.db.prepare("UPDATE work_orders SET completed_at='2026-08-20T07:30:00Z',latitude_snapshot=55.8,longitude_snapshot=37.9 WHERE id=?").run(protectedJob.id);
  const result=await calculate();
  assert.equal(result.routes[0].shiftStartAt,"2026-08-20T08:00:00.000Z");
  assert.deepEqual(result.routes[0].startPoint,{lat:55.8,lon:37.9});
  assert.equal(result.planningAt,"2026-08-20T08:00:00Z");
  await app.json("/api/planning",{method:"POST",body:{serviceDate:"2026-08-20",eventAt:"2026-08-21T08:00:00Z"}},400);
  await app.json("/api/planning",{method:"POST",body:{serviceDate:"2026-08-20",eventAt:""}},400);
  await app.json("/api/engineers/availability?workerId=EMP-402",{cookie:`${app.cookie}; mmi_organization=ORG-002`},404);
  const current=await availability();
  await app.json("/api/engineers/availability",{method:"PUT",body:{workerId:"EMP-402",activityRevision:current.activityRevision,availableAt:"2026-02-31T12:00",address:"Адрес"}},400);
});

test("AVAIL-05 an expired busy estimate does not release the worker early, and local regional times do not depend on the browser",async()=>{
  await prepare();
  app.db.exec("UPDATE workers SET timezone='Asia/Yekaterinburg' WHERE id='EMP-402'");
  await saveAvailability({availableAt:"2026-08-20T14:00"});
  assert.equal(app.db.prepare("SELECT available_at FROM worker_planning_availability").get().available_at,"2026-08-20T09:00:00.000Z");
  assert.equal((await calculate("2026-08-20T10:00:00Z")).metrics.plannedJobs,0);
});
