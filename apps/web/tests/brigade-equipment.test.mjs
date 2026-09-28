import assert from 'node:assert/strict';
import {before,after,beforeEach,afterEach,test} from 'node:test';
import {isolatedWorker} from './helpers/isolated-worker.mjs';
import {equipmentScenario} from './helpers/brigade-equipment.mjs';
let app;
before(async()=>{app=await isolatedWorker();});after(()=>app?.close());
beforeEach(()=>app.db.exec('SAVEPOINT equipment_day'));afterEach(()=>app.db.exec('ROLLBACK TO equipment_day; RELEASE equipment_day'));
const calculate=async()=> (await app.json('/api/planning',{method:'POST',body:{serviceDate:'2026-08-20'}},201)).result;

test('GEAR-01 before departure planning can assign every required type and first departure freezes the whole day',async()=>{
  const f=await equipmentScenario(app);const a=await f.create(0),b=await f.create(1);
  assert.equal((await f.read()).issued,null);
  const plan=await calculate();assert.equal(plan.metrics.plannedJobs,2);
  await app.json('/api/planning',{method:'PUT',body:{planId:plan.planId}});
  const assigned=(await app.json('/api/requests')).items.find(j=>j.id===a.id);
  await app.json('/api/requests',{method:'PUT',body:{...assigned,status:'working'}});
  const state=await f.read();assert.deepEqual(new Set(state.issued.items.map(e=>e.equipmentId)),new Set(f.equipment.map(e=>e.id)));
  assert.equal(state.issued.source,'plan_at_departure');
  assert.ok(state.planned.orderIds.includes(b.id));
  const next=await app.json(`/api/engineers/equipment?workerId=${f.worker.id}&date=2026-08-21`);assert.equal(next.issued,null);
});

test('GEAR-02 replanning a departed brigade cannot obtain equipment from a new request; manual assignment remains possible with a persistent warning',async()=>{
  const f=await equipmentScenario(app);await f.issue([f.equipment[0].id]);
  const a=await f.create(0),b=await f.create(1);const plan=await calculate();
  assert.deepEqual(plan.routes.flatMap(r=>r.visits).map(v=>v.jobId),[a.id]);
  assert.equal(plan.unassigned[0].jobId,b.id);assert.match(plan.unassigned[0].detail,/Лестница/);
  await app.json('/api/planning',{method:'PUT',body:{planId:plan.planId}});
  const fresh=(await app.json('/api/requests')).items.find(j=>j.id===b.id);
  const manual=(await app.json('/api/requests',{method:'PUT',body:{...fresh,status:'assigned',assignee:f.worker.name,assigneeId:f.worker.id}})).item;
  assert.match(manual.equipmentWarning,/У бригады нет оборудования: Лестница/);
  assert.match(manual.schedulingChanges[0].reason,/Назначена вручную/);
  assert.deepEqual((await f.read()).issued.items.map(e=>e.equipmentId),[f.equipment[0].id]);
  const report=(await app.json(`/api/planning/equipment?date=${f.date}`)).report;
  assert.equal(report.groups[0].items.length,2);assert.equal(report.groups[0].issued.items.length,1);
  const again=await calculate();assert.equal(again.unassigned[0].jobId,b.id);assert.ok(again.changes.some(c=>c.jobId===b.id && c.after.workerId===null));
});

test('GEAR-03 shared equipment can be issued, while stale edits and access to another division worker are rejected',async()=>{
  const f=await equipmentScenario(app);await f.create(1);const prior=await f.read(),plan=await calculate();
  await f.issue([]);await app.json('/api/planning',{method:'PUT',body:{planId:plan.planId}},409);
  await app.json('/api/engineers/equipment',{method:'PUT',body:{workerId:f.worker.id,date:f.date,revision:prior.revision,equipmentIds:[f.equipment[1].id],reason:'Старая карточка'}},409);
  await f.issue([f.equipment[1].id]);assert.equal((await calculate()).metrics.plannedJobs,1);
  const foreign=await app.json('/api/admin/equipment',{method:'POST',cookie:`${app.cookie}; mmi_organization=ORG-002`,body:{name:'Чужой',unit:'шт',usage:'reusable',active:true}},201);
  const current=await f.read();await app.json('/api/engineers/equipment',{method:'PUT',body:{workerId:f.worker.id,date:f.date,revision:current.revision,equipmentIds:[foreign.item.id],reason:'Общий каталог'}});
  assert.deepEqual((await f.read()).issued.items.map(item=>item.equipmentId),[foreign.item.id]);
  await app.json(`/api/engineers/equipment?workerId=${f.worker.id}&date=${f.date}`,{cookie:`${app.cookie}; mmi_organization=ORG-002`},404);
});

test('GEAR-04 a departure during publication invalidates the input and no partial assignment is applied',async()=>{
  const f=await equipmentScenario(app);const a=await f.create(0,true),b=await f.create(1);const plan=await calculate();
  const batch=app.database.batch;let once=true;app.database.batch=async statements=>{if(once){once=false;app.db.prepare("UPDATE work_orders SET status='en_route' WHERE id=?").run(a.id);}return batch(statements);};
  try {await app.json('/api/planning',{method:'PUT',body:{planId:plan.planId}},409);}finally{app.database.batch=batch;}
  assert.equal(app.db.prepare('SELECT assignee_worker_id FROM work_orders WHERE id=?').get(b.id).assignee_worker_id,null);
  assert.deepEqual((await f.read()).issued.items.map(e=>e.equipmentId),[f.equipment[0].id]);
  assert.equal(app.db.prepare('SELECT status FROM route_plans WHERE id=?').get(plan.planId).status,'draft');
});

test('GEAR-05 legacy active work without a receipt is unknown, never inferred from later manual assignments',async()=>{
  const f=await equipmentScenario(app);await f.create(1,true);
  app.db.exec("UPDATE work_orders SET status='in_progress' WHERE id='A-1428'");
  app.db.prepare('DELETE FROM worker_day_equipment WHERE worker_id=?').run(f.worker.id);
  const state=await f.read();assert.equal(state.issued.items,null);
  const job=(await app.json('/api/requests')).items.find(j=>j.work===f.types[1].name);
  assert.match(job.equipmentWarning,/полученное оборудование не указано/);
  await f.issue([f.equipment[1].id]);assert.equal((await f.read()).issued.items.length,1);
});

test('GEAR-06 the real mobile departure command freezes equipment atomically and an offline replay cannot replenish it',async()=>{
  const f=await equipmentScenario(app),a=await f.create(0,true);
  app.db.exec(`UPDATE users SET password_salt=(SELECT password_salt FROM users WHERE id='QA-ADMIN'),password_hash=(SELECT password_hash FROM users WHERE id='QA-ADMIN'),password_iterations=1000,must_change_password=0 WHERE id='USR-402'`);
  const email=app.db.prepare("SELECT email FROM users WHERE id='USR-402'").get().email;
  const {token}=await app.json('/api/mobile/v1/auth/login',{method:'POST',body:{email,password:'isolated-test-password'}});
  const command={operationId:crypto.randomUUID(),action:'status',visitId:a.id,revision:a.revision,status:'en_route'};
  const headers={authorization:`Bearer ${token}`};
  await app.json('/api/mobile/v1/commands',{method:'POST',cookie:'',headers,body:command});
  const before=(await f.read()).issued;assert.deepEqual(before.items.map(e=>e.equipmentId),[f.equipment[0].id]);
  const b=await f.create(1,true);
  const replay=await app.json('/api/mobile/v1/commands',{method:'POST',cookie:'',headers,body:command});assert.equal(replay.replayed,true);
  assert.deepEqual((await f.read()).issued,before);
  assert.match((await app.json('/api/requests')).items.find(j=>j.id===b.id).equipmentWarning,/Лестница/);
});

test('GEAR-07 all equipment of a composite visit is required, even when only its second HD needs the missing tool',async()=>{
  const f=await equipmentScenario(app);await f.issue([f.equipment[0].id]);const a=await f.create(0);
  await app.json('/api/requests',{method:'PUT',body:{...a,workTypeIds:f.types.map(t=>t.id),work:f.types.map(t=>t.name).join(' + '),serviceDurationMinutes:60,durationSource:'Общий норматив для двух работ'}});
  const plan=await calculate();assert.equal(plan.metrics.plannedJobs,0);assert.equal(plan.unassigned[0].jobId,a.id);assert.match(plan.unassigned[0].detail,/Лестница/);
});
