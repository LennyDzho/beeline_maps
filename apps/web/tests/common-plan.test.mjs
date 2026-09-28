import assert from 'node:assert/strict';
import {before,after,beforeEach,afterEach,test} from 'node:test';
import {isolatedWorker} from './helpers/isolated-worker.mjs';
import {commonScenario} from './helpers/common-plan.mjs';
let app;
before(async()=>{app=await isolatedWorker();});after(()=>app?.close());
beforeEach(()=>{app.db.exec('SAVEPOINT common_plan_test');commonScenario(app);});afterEach(()=>app.db.exec('ROLLBACK TO common_plan_test; RELEASE common_plan_test'));
const calculate=async(body={})=>(await app.json('/api/planning/group',{method:'POST',body:{serviceDate:'2026-08-20',...body}},201)).result;
const publish=(plan,status=200,ids=[])=>(app.json('/api/planning/group',{method:'PUT',body:{planId:plan.planId,clientNotifiedApprovalIds:ids}},status));
const assignments=()=>app.db.prepare("SELECT id,assignee_worker_id,status,scheduled_start,revision FROM work_orders ORDER BY id").all();

test('COMMON-15 cancelled calculation never commits a partial group or child plan',async()=>{
  const controller=new AbortController();
  const groups=app.db.prepare('SELECT id,status FROM route_plan_groups ORDER BY id').all();
  const plans=app.db.prepare('SELECT id,status FROM route_plans ORDER BY id').all();
  const before=assignments();
  controller.abort();
  await app.json('/api/planning/group',{method:'POST',body:{serviceDate:'2026-08-20'},signal:controller.signal},409);
  assert.deepEqual(app.db.prepare('SELECT id,status FROM route_plan_groups ORDER BY id').all(),groups);
  assert.deepEqual(app.db.prepare('SELECT id,status FROM route_plans ORDER BY id').all(),plans);
  assert.deepEqual(assignments(),before);
});

test('COMMON-17 global calculation deadline is used without committing a timed-out plan',async()=>{
  app.db.exec('UPDATE system_settings SET calculation_timeout_seconds=420 WHERE id=1');
  const timeout=AbortSignal.timeout,seen=[];
  AbortSignal.timeout=ms=>{seen.push(ms);return ms===420000 ? AbortSignal.abort(new DOMException('timeout','TimeoutError')) : timeout(ms);};
  const before=app.db.prepare('SELECT id,status FROM route_plan_groups ORDER BY id').all();
  try {
    const response=await app.json('/api/planning/group',{method:'POST',body:{serviceDate:'2026-08-20'}},504);
    assert.match(response.message,/420 с/);
    assert.ok(seen.includes(420000));
    assert.deepEqual(app.db.prepare('SELECT id,status FROM route_plan_groups ORDER BY id').all(),before);
  } finally {AbortSignal.timeout=timeout;}
});

test('COMMON-13 OSRM-only calculation never requests 2GIS matrix or routing',async()=>{
  const workspace=await app.json('/api/planning/workspace');
  assert.ok(workspace.planningSettings.travelMatrixProvider==='osrm');
  const start=app.calls.length;
  const plan=await calculate();
  assert.ok(plan.departments.every(d=>d.providerId==='osrm'));
  const calls=app.calls.slice(start);
  assert.ok(calls.some(c=>c.startsWith('osrm.test/table/')));
  assert.ok(!calls.some(c=>c.includes('2gis')));
});

test('COMMON-14 a global source failure reports its department and leaves all plans unchanged',async()=>{
  app.db.exec("UPDATE system_settings SET travel_matrix_provider='two_gis' WHERE id=1");
  const workspace=await app.json('/api/planning/workspace');
  const department=workspace.departments[0];
  assert.equal(workspace.planningSettings.travelMatrixProvider,'two_gis');
  const original=globalThis.fetch,before=assignments(),plans=app.db.prepare('SELECT * FROM route_plans ORDER BY id').all();
  globalThis.fetch=async(input,options)=>{
    const url=new URL(input instanceof Request ? input.url : input);
    if(url.hostname.includes('2gis'))return Response.json({message:'Forbidden'},{status:403});
    return original(input,options);
  };
  try {
    const response=await app.json('/api/planning/group',{method:'POST',body:{serviceDate:'2026-08-20'}},424);
    assert.ok(response.message.startsWith(department.name+' · источник расчёта 2ГИС:'));
    assert.match(response.message,/2ГИС/);
    assert.deepEqual(assignments(),before);
    assert.deepEqual(app.db.prepare('SELECT * FROM route_plans ORDER BY id').all(),plans);
  } finally {globalThis.fetch=original;}
});

test('COMMON-01 all accessible departments form one saved plan with independent worker pools and atomic publication',async()=>{
  const before=assignments(),plan=await calculate({departmentId:'ORG-001'});
  assert.equal(plan.departments.length,2);assert.equal(plan.metrics.plannedJobs,2);assert.equal(plan.metrics.engineersUsed,2);
  assert.deepEqual(assignments(),before);
  for(const route of plan.routes)assert.equal(route.visits[0].jobId,route.agentId.replace('-W','-J'));
  assert.equal((await app.json('/api/planning/group?date=2026-08-20')).result.planId,plan.planId);
  await app.json('/api/planning',{method:'PUT',body:{planId:plan.departments[0].planId}},409);
  await publish(plan);assert.equal(assignments().filter(o=>o.id.startsWith('COMMON-')&&o.status==='assigned').length,2);
  assert.equal((await app.json('/api/planning/group?date=2026-08-20')).result.status,'published');
  await publish(plan,409);
});

test('COMMON-15 saving global settings through another department invalidates a shared draft',async()=>{
  const plan=await calculate();
  const cookie=`${app.cookie}; mmi_organization=ORG-002`;
  const {settings}=await app.json('/api/admin/bootstrap',{cookie});
  await app.json('/api/admin/settings',{method:'PUT',cookie,body:{...settings,optimizerPolicy:'emergency_staff/v1'}});
  assert.equal((await app.json('/api/admin/bootstrap')).settings.optimizerPolicy,'emergency_staff/v1');
  assert.equal((await app.json('/api/planning/group?date=2026-08-20')).outdated,true);
  await publish(plan,409);
});

test('COMMON-02 a late edit in any department rolls back every assignment and publication',async()=>{
  const plan=await calculate(),batch=app.database.batch;let once=true;
  app.database.batch=async statements=>{if(once){once=false;app.db.exec("UPDATE work_orders SET description='Изменилось' WHERE id='COMMON-2-J'");}return batch(statements);};
  try{await publish(plan,409);}finally{app.database.batch=batch;}
  assert.equal(app.db.prepare("SELECT COUNT(*) n FROM work_orders WHERE id LIKE 'COMMON-%' AND assignee_worker_id IS NOT NULL").get().n,0);
  assert.equal(app.db.prepare("SELECT status FROM route_plan_groups WHERE id=?").get(plan.planId).status,'draft');
  assert.equal(app.db.prepare("SELECT COUNT(*) n FROM route_plans WHERE status='published'").get().n,0);
});

test('COMMON-03 failure after the first department writes still rolls back the whole transaction',async()=>{
  const plan=await calculate(),before=assignments();
  app.db.exec("CREATE TRIGGER common_test_failure BEFORE UPDATE ON work_orders WHEN NEW.id='COMMON-2-J' BEGIN SELECT RAISE(ABORT,'simulated second department failure'); END");
  await publish(plan,500);assert.deepEqual(assignments(),before);
  assert.equal(app.db.prepare("SELECT COUNT(*) n FROM route_plans WHERE status='published'").get().n,0);
});

test('COMMON-04 permission changes during publication reject the entire group',async()=>{
  const plan=await calculate(),batch=app.database.batch;let once=true;
  app.database.batch=async statements=>{if(once){once=false;app.db.exec("UPDATE memberships SET status='revoked' WHERE user_id='QA-ADMIN' AND organization_id='ORG-002'");}return batch(statements);};
  try{await publish(plan,409);}finally{app.database.batch=batch;}
  assert.equal(assignments().filter(o=>o.id.startsWith('COMMON-')&&o.assignee_worker_id).length,0);
  const visible=await app.json('/api/planning/workspace');assert.deepEqual(visible.departments.map(d=>d.id),['ORG-001']);
  await app.json('/api/requests',{headers:{'X-MMI-Organization':'ORG-002'}},403);
  await publish(plan,404);
});

test('COMMON-05 empty departments participate in stale checks and no available worker gives a readable unassigned reason',async()=>{
  app.db.exec("UPDATE work_orders SET status='cancelled' WHERE id='COMMON-2-J'");
  const plan=await calculate();assert.equal(plan.departments[1].planId,null);
  app.db.exec("UPDATE work_orders SET status='new' WHERE id='COMMON-2-J'; UPDATE workers SET active=0 WHERE id='COMMON-2-W'");
  await publish(plan,409);
  const next=await calculate();assert.equal(next.metrics.plannedJobs,1);assert.match(next.unassigned[0].detail,/нет активных исполнителей/i);
  await publish(next);
});

test('COMMON-06 client acknowledgement is required for every department and shared drafts cannot be partially superseded',async()=>{
  app.db.exec("UPDATE work_orders SET assignee_worker_id=REPLACE(id,'-J','-W'),status='assigned',client_visit_confirmed=1 WHERE id LIKE 'COMMON-%'");
  const plan=await calculate({eventTime:'14:00'});assert.equal(plan.clientApprovals.length,2);
  await publish(plan,409,[plan.clientApprovals[0].id]);
  await publish(plan,200,plan.clientApprovals.map(a=>a.id));
  assert.equal(app.db.prepare("SELECT COUNT(*) n FROM audit_events WHERE action='client_notified' AND entity_id LIKE 'COMMON-%'").get().n,2);
  const next=await calculate();
  await app.json('/api/planning',{method:'POST',body:{serviceDate:'2026-08-20'}},201);
  assert.equal((await app.json('/api/planning/group?date=2026-08-20')).outdated,true);
  await publish(next,409,next.clientApprovals.map(a=>a.id));
});

test('COMMON-07 workspace, equipment and notification scopes never leak a foreign department',async()=>{
  const data=await app.json('/api/planning/workspace');assert.equal(data.items.filter(i=>i.id.startsWith('COMMON-')).length,2);
  const plan=await calculate();
  const all=await app.json(`/api/planning/group/equipment?date=2026-08-20&planId=${plan.planId}`);assert.equal(all.report.requestCount,2);
  const one=await app.json(`/api/planning/group/equipment?date=2026-08-20&planId=${plan.planId}&departmentId=ORG-002`);assert.equal(one.report.requestCount,1);assert.equal(one.report.groups[0].organizationId,'ORG-002');
  await app.json('/api/planning/group/equipment?date=2026-08-20&departmentId=ORG-003',{},403);
  await app.json('/api/notifications',{headers:{'X-MMI-Organization':'ORG-003'}},403);
  const foreign=await app.json('/api/requests',{headers:{'X-MMI-Organization':'ORG-002'}});assert.equal(foreign.items.length,1);assert.equal(foreign.items[0].id,'COMMON-2-J');
  app.db.exec("UPDATE work_orders SET description='Изменилось' WHERE id='COMMON-1-J'");
  await app.json(`/api/planning/group/equipment?date=2026-08-20&planId=${plan.planId}&departmentId=ORG-002`,{},409);
});

test('COMMON-16 empty time includes the entire selected day even when it is today',async t=>{
  t.mock.timers.enable({apis:['Date'],now:new Date('2026-08-20T12:00:00Z')});
  app.db.exec("UPDATE work_orders SET client_window_end='2026-08-20T08:00:00.000Z' WHERE id LIKE 'COMMON-%-J'");
  const fullDay=await calculate();
  assert.equal(fullDay.metrics.plannedJobs,2,'morning appointments remain eligible when the clock shows afternoon');
  assert.ok(fullDay.departments.every(d=>d.planningAt==='2026-08-20T06:00:00.000Z'));
  const fromAfternoon=await calculate({eventTime:'15:00'});
  assert.equal(fromAfternoon.metrics.plannedJobs,0,'explicit time still excludes earlier windows');
  assert.ok(fromAfternoon.departments.every(d=>d.planningAt==='2026-08-20T12:00:00.000Z'));
  t.mock.timers.setTime(new Date('2026-08-21T12:00:00Z').getTime());
  const selectedPastDay=await calculate();
  assert.equal(selectedPastDay.serviceDate,'2026-08-20');
  assert.equal(selectedPastDay.metrics.plannedJobs,2);
  assert.ok(selectedPastDay.departments.every(d=>d.planningAt==='2026-08-20T06:00:00.000Z'));
});

test('COMMON-08 the same local event time is converted independently in each department',async()=>{
  app.db.exec("UPDATE organizations SET timezone='Asia/Yekaterinburg' WHERE id='ORG-002'; UPDATE workers SET timezone='Asia/Yekaterinburg' WHERE id='COMMON-2-W'");
  const plan=await calculate({eventTime:'10:00'});
  assert.equal(plan.departments[0].planningAt,'2026-08-20T07:00:00.000Z');assert.equal(plan.departments[1].planningAt,'2026-08-20T05:00:00.000Z');
});

test('COMMON-09 two competing publications apply one complete plan exactly once',async()=>{
  const plan=await calculate();
  const responses=await Promise.all([1,2].map(()=>app.request('/api/planning/group',{method:'PUT',body:{planId:plan.planId}})));
  assert.deepEqual(responses.map(r=>r.status).sort(),[200,409]);
  assert.equal(app.db.prepare("SELECT COUNT(*) n FROM audit_events WHERE entity_type='route_plan' AND action='published'").get().n,2);
  assert.equal(assignments().filter(o=>o.id.startsWith('COMMON-')&&o.status==='assigned').length,2);
});

test('COMMON-10 permissions are rechecked when saving the calculation and no partial draft appears',async()=>{
  const batch=app.database.batch;let once=true;
  app.database.batch=async statements=>{if(once){once=false;app.db.exec("UPDATE memberships SET status='revoked' WHERE user_id='QA-ADMIN' AND organization_id='ORG-002'");}return batch(statements);};
  try{await app.json('/api/planning/group',{method:'POST',body:{serviceDate:'2026-08-20'}},409);}finally{app.database.batch=batch;}
  assert.equal(app.db.prepare('SELECT COUNT(*) n FROM route_plans').get().n,0);
  assert.equal(app.db.prepare('SELECT COUNT(*) n FROM route_plan_groups').get().n,0);
});

test('COMMON-11 a second department solver failure preserves all previous drafts',async()=>{
  const previous=await calculate();
  const before=app.db.prepare('SELECT id,status FROM route_plans ORDER BY id').all();
  app.db.exec("UPDATE system_settings SET optimization_engine='ortools' WHERE id=1");
  app.solverHandler=()=>Response.json({error:'busy'},{status:503});
  try {
    const response=await app.request('/api/planning/group',{method:'POST',body:{serviceDate:'2026-08-20'}});
    assert.ok(response.status>=400);assert.deepEqual(app.db.prepare('SELECT id,status FROM route_plans ORDER BY id').all(),before);
    assert.equal(app.db.prepare('SELECT status FROM route_plan_groups WHERE id=?').get(previous.planId).status,'draft');
  } finally{app.solverHandler=null;}
});

test('COMMON-12 losing one department keeps the other available independently of the current cookie',async()=>{
  app.db.exec("DELETE FROM role_permissions WHERE role_id='administrator' AND permission_code='planning.manage'");
  const workspace=await app.json('/api/planning/workspace');
  assert.deepEqual(workspace.departments.map(d=>d.id),['ORG-002']);assert.ok(workspace.items.every(item=>item.organizationId==='ORG-002'));
  const plan=await calculate();assert.equal(plan.departments.length,1);assert.equal(plan.routes[0].agentId,'COMMON-2-W');
  await publish(plan);
  assert.equal(app.db.prepare("SELECT assignee_worker_id FROM work_orders WHERE id='COMMON-1-J'").get().assignee_worker_id,null);
});

test('COMMON-18 stored routes remain available for viewing, only method changes request recalculation',async()=>{
  const plan=await calculate();
  app.db.exec("UPDATE workers SET phone='12345',updated_at='2026-09-28T12:00:00Z' WHERE id='COMMON-1-W'");
  const saved=await app.json('/api/planning/group?date=2026-08-20');
  assert.equal(saved.outdated,true);
  assert.equal(saved.methodsChanged,false);
  assert.equal(saved.result,null);
  assert.deepEqual(saved.displayResult.routes,plan.routes);
  await publish(plan,409);
  assert.deepEqual(await app.json('/api/planning/group?date=2026-08-21'),{result:null,outdated:false});
  for (const update of ["optimization_engine='ortools',travel_matrix_provider='osrm'","optimization_engine='pyvrp',travel_matrix_provider='two_gis'"]) {
    app.db.exec(`UPDATE system_settings SET ${update} WHERE id=1`);
    const changed=await app.json('/api/planning/group?date=2026-08-20');
    assert.equal(changed.methodsChanged,true);
    assert.equal(changed.displayResult,null);
    assert.equal(changed.result,null);
  }
});

test('COMMON-19 browsing a day skips saved proposals and returns the published plan if present',async()=>{
  const draft=await calculate();
  assert.deepEqual(await app.json('/api/planning/group?date=2026-08-20&publishedOnly=1'),{result:null,outdated:false});
  await publish(draft);
  const nextDraft=await calculate();
  const actual=await app.json('/api/planning/group?date=2026-08-20&publishedOnly=1');
  assert.equal(actual.result.planId,draft.planId);
  assert.equal(actual.result.status,'published');
  assert.equal((await app.json('/api/planning/group?date=2026-08-20')).result.planId,nextDraft.planId);
});
