import assert from "node:assert/strict";
import {before,after,beforeEach,afterEach,test} from "node:test";
import {execFileSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {isolatedWorker} from "./helpers/isolated-worker.mjs";

let app;
const python=process.env.OPTIMIZER_TEST_PYTHON ?? fileURLToPath(new URL(process.platform === "win32" ? "../../../algorithm-research/benchmark/.venv/Scripts/python.exe" : "../../../algorithm-research/benchmark/.venv/bin/python",import.meta.url));
const solver=fileURLToPath(new URL("../../../services/optimizer/solver.py",import.meta.url));
const settings={appName:"Марш!",timezone:"Europe/Moscow",emailAlerts:true,weeklyDigest:false,optimizationEngine:"ortools",travelMatrixProvider:"osrm",optimizerPolicy:"emergency_fast/v1"};
before(async()=>{app=await isolatedWorker();});
after(()=>app?.close());
beforeEach(()=>{app.db.exec("SAVEPOINT solver_scenario"); app.solverHandler=input=>Response.json(JSON.parse(execFileSync(python,[solver],{input:JSON.stringify({...input,timeLimitMs:150}),encoding:"utf8",timeout:15000,windowsHide:true})));});
afterEach(()=>app.db.exec("ROLLBACK TO solver_scenario; RELEASE solver_scenario"));

async function prepare() {
  app.db.exec("UPDATE work_orders SET status='cancelled'; UPDATE workers SET active=0 WHERE id<>'EMP-402'");
  await app.json("/api/admin/settings",{method:"PUT",body:settings});
  const {item}=await app.json("/api/requests",{method:"POST",body:{work:"Ремонт оборудования",description:"Сервис решателя",priority:"high",status:"new",dateTime:"2026-08-20T10:00",address:"Москва, Тестовая, 1",assignee:"",clientWindowStart:"2026-08-20T09:00",clientWindowEnd:"2026-08-20T17:00"}},201);
  return item;
}

test("SOLVER-01 real Worker API → application adapter → real OR-Tools → validated draft → atomic publication",async()=>{
  const job=await prepare();
  const {result}=await app.json("/api/planning",{method:"POST",body:{serviceDate:"2026-08-20"}},201);
  assert.equal(result.metrics.plannedJobs,1); assert.equal(result.metrics.hardViolations,0);
  assert.equal(result.routes[0].visits[0].jobId,job.id); assert.equal(result.routes[0].visits[0].distanceKm,1);
  assert.match(result.optimizerId,/ortools=.*policy=emergency_fast\/v1/);
  const stored=JSON.parse(app.db.prepare("SELECT result_json FROM route_plans WHERE id=?").get(result.planId).result_json);
  assert.deepEqual(stored,result);
  await app.json("/api/planning",{method:"PUT",body:{planId:result.planId}});
  const row=app.db.prepare("SELECT status,assignee_worker_id,client_window_start,client_window_end FROM work_orders WHERE id=?").get(job.id);
  assert.equal(row.status,"assigned"); assert.equal(row.assignee_worker_id,"EMP-402");
  assert.equal(row.client_window_start,"2026-08-20T06:00:00.000Z"); assert.equal(row.client_window_end,"2026-08-20T14:00:00.000Z");
});

test("SOLVER-02 engine/policy round-trip, omitted policy preservation and stale publication guard",async()=>{
  await prepare();
  await app.json("/api/admin/settings",{method:"PUT",body:{...settings,optimizerPolicy:"emergency_staff/v1"}});
  const legacy={...settings}; delete legacy.optimizerPolicy;
  await app.json("/api/admin/settings",{method:"PUT",body:legacy});
  const bootstrap=await app.json("/api/admin/bootstrap");
  assert.equal(bootstrap.settings.optimizationEngine,"ortools"); assert.equal(bootstrap.settings.optimizerPolicy,"emergency_staff/v1");
  const {result}=await app.json("/api/planning",{method:"POST",body:{serviceDate:"2026-08-20"}},201);
  await app.json("/api/admin/settings",{method:"PUT",body:settings});
  await app.json("/api/planning",{method:"PUT",body:{planId:result.planId}},409);
  await app.json("/api/admin/settings",{method:"PUT",body:{...settings,optimizerPolicy:"invented"}},400);
});

test("SOLVER-03 service failure preserves previous draft and does not silently use the greedy optimizer",async()=>{
  await prepare();
  const {result}=await app.json("/api/planning",{method:"POST",body:{serviceDate:"2026-08-20"}},201);
  app.solverHandler=()=>Response.json({error:"busy"},{status:503});
  const response=await app.request("/api/planning",{method:"POST",body:{serviceDate:"2026-08-20"}});
  assert.ok(response.status>=400); assert.match((await response.json()).message,/OR-Tools/);
  assert.equal(app.db.prepare("SELECT status FROM route_plans WHERE id=?").get(result.planId).status,"draft");
  assert.equal(app.db.prepare("SELECT COUNT(*) n FROM route_plans").get().n,1);
});

test("PYVRP-API global settings, real solver, validated draft and publication",async()=>{
  const job=await prepare();
  await app.json('/api/admin/settings',{method:'PUT',body:{...settings,scope:'planning',optimizationEngine:'pyvrp'}});
  assert.equal((await app.json('/api/admin/bootstrap')).settings.optimizationEngine,'pyvrp');
  const {result}=await app.json('/api/planning',{method:'POST',body:{serviceDate:'2026-08-20'}},201);
  assert.match(result.optimizerId,/pyvrp=0\.14/);
  assert.equal(result.metrics.plannedJobs,1);assert.equal(result.metrics.hardViolations,0);
  assert.equal(result.routes[0].visits[0].jobId,job.id);
  app.solverHandler=()=>Response.json({error:'busy'},{status:503});
  const failed=await app.request('/api/planning',{method:'POST',body:{serviceDate:'2026-08-20'}});
  assert.equal(failed.status,503);assert.match((await failed.json()).message,/PyVRP/);
  assert.equal(app.db.prepare('SELECT COUNT(*) n FROM route_plans').get().n,1);
  await app.json('/api/planning',{method:'PUT',body:{planId:result.planId}});
  assert.equal(app.db.prepare('SELECT status FROM work_orders WHERE id=?').get(job.id).status,'assigned');
});

test("PYVRP-REPLAN preserves started work and resumes only after explicit availability",async()=>{
  const protectedJob=await prepare();
  app.db.prepare("UPDATE work_orders SET assignee_worker_id='EMP-402',status='in_progress' WHERE id=?").run(protectedJob.id);
  const before=app.db.prepare('SELECT * FROM work_orders WHERE id=?').get(protectedJob.id);
  const queued=(await app.json('/api/requests',{method:'POST',body:{work:'Ремонт оборудования',description:'Оставшаяся очередь',priority:'high',status:'new',dateTime:'2026-08-20T14:00',address:'Москва, Тестовая, 1',assignee:'',clientWindowStart:'2026-08-20T09:00',clientWindowEnd:'2026-08-20T17:00'}},201)).item;
  await app.json('/api/admin/settings',{method:'PUT',body:{...settings,scope:'planning',optimizationEngine:'pyvrp'}});
  const recalculate=()=>app.json('/api/planning',{method:'POST',body:{serviceDate:'2026-08-20',eventAt:'2026-08-20T08:00:00Z'}},201).then(r=>r.result);
  const unknown=await recalculate();assert.equal(unknown.routes.length,0);assert.deepEqual(unknown.protectedJobIds,[protectedJob.id]);
  const availability=await app.json('/api/engineers/availability?workerId=EMP-402');
  await app.json('/api/engineers/availability',{method:'PUT',body:{workerId:'EMP-402',activityRevision:availability.activityRevision,availableAt:'2026-08-20T12:00',address:'Москва, Тестовая, 1'}});
  const result=await recalculate();
  assert.match(result.optimizerId,/pyvrp/);assert.equal(result.metrics.hardViolations,0);
  assert.equal(result.routes[0].visits[0].jobId,queued.id);
  assert.equal(result.routes[0].visits[0].serviceStartAt,'2026-08-20T10:00:00.000Z');
  await app.json('/api/planning',{method:'PUT',body:{planId:result.planId}});
  assert.deepEqual(app.db.prepare('SELECT * FROM work_orders WHERE id=?').get(protectedJob.id),before);
});
