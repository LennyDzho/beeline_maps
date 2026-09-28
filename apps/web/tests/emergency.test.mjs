import assert from 'node:assert/strict';
import {before,after,beforeEach,afterEach,test} from 'node:test';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {isolatedWorker} from './helpers/isolated-worker.mjs';
import {commonScenario} from './helpers/common-plan.mjs';
let app;
const python=process.env.OPTIMIZER_TEST_PYTHON ?? fileURLToPath(new URL(process.platform==='win32' ? '../../../algorithm-research/benchmark/.venv/Scripts/python.exe' : '../../../algorithm-research/benchmark/.venv/bin/python',import.meta.url));
const solver=fileURLToPath(new URL('../../../services/optimizer/solver.py',import.meta.url));
before(async()=>{app=await isolatedWorker();});after(()=>app?.close());
beforeEach(()=>{app.db.exec('SAVEPOINT emergency');commonScenario(app);});afterEach(()=>{app.solverHandler=null;app.db.exec('ROLLBACK TO emergency; RELEASE emergency');});
async function type(extra={}) {
  const category=(await app.json('/api/admin/work-categories',{method:'POST',body:{name:'Аварийные работы',description:'',active:true}},201)).item;
  const work=(await app.json('/api/admin/work-types',{method:'POST',body:{name:'Авария',description:'',plannedDurationMinutes:60,verificationMethodId:'dispatcher',requiredSkills:[],requiredQualifications:[],categoryIds:[category.id],...extra}},201)).item;
  app.db.prepare('INSERT INTO worker_work_competencies(worker_id,category_id,work_type_id) VALUES (?,?,?)').run('COMMON-1-W',category.id,work.id);
  return work;
}
async function create(work,extra={}) {return (await app.json('/api/requests',{method:'POST',body:{work:work.name,workTypeIds:[work.id],categoryId:work.categoryIds[0],description:'Аварийный выезд',priority:'low',status:'new',dateTime:'2026-08-20T14:00',address:'Москва, Тестовая улица, 1',assignee:'',clientWindowStart:'2026-08-20T20:00',clientWindowEnd:'2026-08-20T22:00',...extra}},201)).item;}

test('EMERGENCY-01 new emergencies receive high priority and a local calendar-day window while original input survives in audit',async()=>{
  const work=await type();assert.equal(work.isEmergency,true);const job=await create(work);
  assert.equal(job.isEmergency,true);assert.equal(job.priority,'high');assert.equal(job.clientWindowStart,'2026-08-20T00:00');assert.equal(job.clientWindowEnd,'2026-08-20T23:59');
  const row=app.db.prepare('SELECT client_window_start,client_window_end,priority,assignee_worker_id FROM work_orders WHERE id=?').get(job.id);
  assert.equal(row.client_window_start,'2026-08-19T21:00:00.000Z');assert.equal(row.client_window_end,'2026-08-20T20:59:59.999Z');assert.equal(row.priority,'high');assert.equal(row.assignee_worker_id,null);
  const audit=JSON.parse(app.db.prepare("SELECT payload_json FROM audit_events WHERE entity_id=? AND action='emergency_window_normalized'").get(job.id).payload_json);
  assert.equal(audit.source.start,'2026-08-20T20:00');assert.equal(audit.source.end,'2026-08-20T22:00');
  assert.equal(audit.effective.end,row.client_window_end);
});

test('EMERGENCY-02 catalog renaming and disabling the flag in a new version do not change existing visits',async()=>{
  const work=await type(),job=await create(work);
  const updated=(await app.json('/api/admin/work-types',{method:'PUT',body:{...work,name:'Обрыв линии',isEmergency:false}})).item;
  assert.equal(updated.isEmergency,false);
  const prior=(await app.json('/api/requests')).items.find(i=>i.id===job.id);assert.equal(prior.isEmergency,true);
  const saved=(await app.json('/api/requests',{method:'PUT',body:{...prior,description:'Уточнение',priority:'low',isEmergency:false,dateTime:'2026-08-21T10:00'}})).item;
  assert.equal(saved.isEmergency,true);assert.equal(saved.priority,'high');assert.equal(saved.clientWindowStart,'2026-08-21T00:00');
  assert.deepEqual(saved.workTypeVersionIds,job.workTypeVersionIds);
  const next=await create(updated);assert.equal(next.isEmergency,false);assert.equal(next.priority,'low');assert.equal(next.clientWindowStart,'2026-08-20T20:00');
});

test('EMERGENCY-03 each region defines its own midnight, not 24 hours after the planned visit',async()=>{
  app.db.exec("UPDATE organizations SET timezone='Asia/Yekaterinburg' WHERE id='ORG-001'");
  const job=await create(await type());const row=app.db.prepare('SELECT client_window_start,client_window_end FROM work_orders WHERE id=?').get(job.id);
  assert.equal(row.client_window_start,'2026-08-19T19:00:00.000Z');assert.equal(row.client_window_end,'2026-08-20T18:59:59.999Z');
});

for (const engine of ['ortools','pyvrp']) {
test(`EMERGENCY-04 ${engine} inserts a newly created emergency early, respects release and explains later changes`,async()=>{
  const job=await create(await type());
  app.db.prepare("UPDATE work_orders SET created_at='2026-08-20T07:00:00.000Z',client_window_start=NULL,client_window_end=NULL WHERE id=?").run(job.id);
  app.db.exec("UPDATE work_orders SET assignee_worker_id='COMMON-1-W',status='assigned',scheduled_start='2026-08-20T10:00',scheduled_end='2026-08-20T11:00' WHERE id='COMMON-1-J'");
  await app.json('/api/admin/settings',{method:'PUT',body:{appName:'Марш!',timezone:'Europe/Moscow',emailAlerts:true,weeklyDigest:false,optimizationEngine:engine,travelMatrixProvider:'osrm',optimizerPolicy:'emergency_fast/v1'}});
  let captured;
  app.solverHandler=input=>{captured=input;return Response.json(JSON.parse(execFileSync(python,[solver],{input:JSON.stringify({...input,timeLimitMs:300}),encoding:'utf8',timeout:15000,windowsHide:true})));};
  const result=(await app.json('/api/planning',{method:'POST',body:{serviceDate:'2026-08-20',eventAt:'2026-08-20T07:00:00.000Z'}},201)).result;
  assert.equal(captured.jobs.find(j=>j.id===job.id).emergency,true);assert.equal(result.metrics.plannedJobs,2);
  const route=result.routes[0];assert.equal(route.visits[0].jobId,job.id);assert.equal(route.visits[0].serviceStartAt,'2026-08-20T07:05:00.000Z');
  assert.ok(Date.parse(route.visits.at(-1).serviceEndAt)<=Date.parse(route.shiftEndAt));
  assert.equal(result.changes.some(c=>c.jobId===job.id),false,'first assignment stays silent');
  assert.match(result.changes.find(c=>c.jobId==='COMMON-1-J').reason,/срочной аварии/);
  await app.json('/api/planning',{method:'PUT',body:{planId:result.planId}});
});

}

test('EMERGENCY-05 every HD participates in emergency classification, and omitted flags retain the version setting',async()=>{
  const work=await type({name:'Обрыв кабеля',isEmergency:true});
  const legacy={...work,name:'Повреждение кабеля'};delete legacy.isEmergency;
  const renamed=(await app.json('/api/admin/work-types',{method:'PUT',body:legacy})).item;assert.equal(renamed.isEmergency,true);
  const category=(await app.json('/api/admin/work-categories',{method:'POST',body:{name:'Составной выезд',description:'',active:true,workTypeIds:['COMMON-1-T',work.id],serviceDurationMinutes:90,durationSource:'Норматив выезда'}},201)).item;
  for(const id of ['COMMON-1-T',work.id]) {
    const current=(await app.json('/api/admin/bootstrap')).workTypes.find(t=>t.id===id);
    await app.json('/api/admin/work-types',{method:'PUT',body:{...current,categoryIds:[...(current.categoryIds ?? []),category.id]}});
  }
  const job=await create(renamed,{work:'Общая работа + Повреждение кабеля',categoryId:category.id,workTypeIds:['COMMON-1-T',work.id],serviceDurationMinutes:90,durationSource:'Норматив выезда'});
  assert.equal(job.isEmergency,true);assert.equal(job.priority,'high');assert.equal(job.workTypeIds.length,2);
});

test('EMERGENCY-06 a calendar day follows a daylight-saving transition and needs no supplied customer interval',async()=>{
  app.db.exec("UPDATE organizations SET timezone='America/New_York' WHERE id='ORG-001'");
  const job=await create(await type(),{dateTime:'2026-03-08T14:00',clientWindowStart:undefined,clientWindowEnd:undefined});
  const row=app.db.prepare('SELECT client_window_start,client_window_end FROM work_orders WHERE id=?').get(job.id);
  assert.equal(row.client_window_start,'2026-03-08T05:00:00.000Z');assert.equal(row.client_window_end,'2026-03-09T03:59:59.999Z');
  assert.equal(Date.parse(row.client_window_end)+1-Date.parse(row.client_window_start),23*60*60*1000);
});

test('EMERGENCY-07 urgency cannot bypass the received equipment of a departed brigade',async()=>{
  const work=await type();
  const gear=(await app.json('/api/admin/equipment',{method:'POST',body:{name:'Аварийный комплект',unit:'шт',usage:'reusable',active:true}},201)).item;
  const equipped=(await app.json('/api/admin/work-types',{method:'PUT',body:{...work,equipmentRequirements:[{equipmentId:gear.id,quantity:null}]}})).item;
  const stock=await app.json('/api/engineers/equipment?workerId=COMMON-1-W&date=2026-08-20');
  await app.json('/api/engineers/equipment',{method:'PUT',body:{workerId:'COMMON-1-W',date:'2026-08-20',revision:stock.revision,equipmentIds:[],reason:'Выехали без аварийного комплекта'}});
  const job=await create(equipped);
  const result=(await app.json('/api/planning',{method:'POST',body:{serviceDate:'2026-08-20'}},201)).result;
  assert.match(result.unassigned.find(item=>item.jobId===job.id).detail,/Аварийный комплект/);
  const manual=(await app.json('/api/requests',{method:'PUT',body:{...job,status:'assigned',assignee:'Одинаковая бригада',assigneeId:'COMMON-1-W'}})).item;
  assert.match(manual.equipmentWarning,/Аварийный комплект/);
});

test('EMERGENCY-08 a legacy window normalization keeps its source and does not fabricate a client appointment change',async()=>{
  const job=await create(await type(),{clientVisitConfirmed:true});
  app.db.prepare("UPDATE work_orders SET client_window_start='2026-08-20T17:00:00.000Z',client_window_end='2026-08-20T19:00:00.000Z' WHERE id=?").run(job.id);
  const current=(await app.json('/api/requests')).items.find(item=>item.id===job.id);
  await app.json('/api/requests',{method:'PUT',body:{...current,description:'Уточнение описания'}});
  assert.equal(app.db.prepare("SELECT COUNT(*) n FROM audit_events WHERE entity_id=? AND action='client_notified'").get(job.id).n,0);
  const audit=JSON.parse(app.db.prepare("SELECT payload_json FROM audit_events WHERE entity_id=? AND action='emergency_window_normalized' ORDER BY rowid DESC LIMIT 1").get(job.id).payload_json);
  assert.equal(audit.source.start,'2026-08-20T17:00:00.000Z');
});
