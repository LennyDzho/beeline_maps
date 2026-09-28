import assert from "node:assert/strict";
import {before,after,beforeEach,afterEach,test} from "node:test";
import {isolatedWorker} from "./helpers/isolated-worker.mjs";
let app;
before(async()=>{app=await isolatedWorker();});
after(()=>app?.close());
beforeEach(()=>app.db.exec("SAVEPOINT client_approval"));
afterEach(()=>app.db.exec("ROLLBACK TO client_approval; RELEASE client_approval"));
const date="2026-08-20";
async function setup(count=1) {
  app.db.exec("UPDATE work_orders SET status='cancelled'");
  await app.json('/api/admin/settings',{method:'PUT',body:{appName:'Марш!',timezone:'Europe/Moscow',emailAlerts:true,weeklyDigest:false,optimizationEngine:'pyvrp',travelMatrixProvider:'osrm'}});
  const worker=(await app.json('/api/engineers')).items.find(w=>w.id==='EMP-402');
  const jobs=[];
  for(let i=0;i<count;i++) jobs.push((await app.json('/api/requests',{method:'POST',body:{work:'Ремонт оборудования',description:'Подтверждённый визит',priority:'medium',status:'assigned',
    dateTime:`${date}T${10+i*2}:00`,address:'Москва, Тестовая, 1',assignee:worker.name,assigneeId:worker.id,clientWindowStart:`${date}T09:00`,clientWindowEnd:`${date}T17:00`,clientVisitConfirmed:true}},201)).item);
  return jobs;
}
function unavailableOriginal() {
  app.db.exec(`UPDATE workers SET active=0;
    UPDATE workers SET active=1,shift_status='on_shift',transport_mode='car',work_schedule_id=(SELECT work_schedule_id FROM workers WHERE id='EMP-402') WHERE id='EMP-390';
    INSERT OR IGNORE INTO worker_skills (worker_id,skill_id) SELECT 'EMP-390',skill_id FROM worker_skills WHERE worker_id='EMP-402';
    INSERT OR IGNORE INTO worker_qualifications (worker_id,qualification_id,status) SELECT 'EMP-390',qualification_id,'valid' FROM worker_qualifications WHERE worker_id='EMP-402';`);
}
const calculate=async()=> (await app.json('/api/planning',{method:'POST',body:{serviceDate:date}},201)).result;
const publish=(plan,ids,status=200)=>app.json('/api/planning',{method:'PUT',body:{planId:plan.planId,...(ids===undefined?{}:{clientNotifiedApprovalIds:ids})}},status);
const acknowledgements=plan=>plan.clientApprovals.map(a=>a.id);

test('CLIENT-01 manual changes require current explicit acknowledgement, cannot bypass by clearing the flag, and retain audit',async()=>{
  const [job]=await setup();
  assert.equal(job.clientVisitConfirmed,true);assert.equal(job.status,'assigned');assert.equal(job.clientNotified,undefined);
  for(const extra of [{},{clientVisitConfirmed:false},{clientNotified:'true'}]) await app.json('/api/requests',{method:'PUT',body:{...job,dateTime:`${date}T11:00`,...extra}},typeof extra.clientNotified==='string'?400:409);
  assert.equal(app.db.prepare('SELECT scheduled_start FROM work_orders WHERE id=?').get(job.id).scheduled_start,job.dateTime);
  const changed=(await app.json('/api/requests',{method:'PUT',body:{...job,dateTime:`${date}T11:00`,clientNotified:true}})).item;
  assert.match(changed.schedulingChanges[0].reason,/сообщил клиенту/);
  const audit=app.db.prepare("SELECT * FROM audit_events WHERE entity_id=? AND action='client_notified'").get(job.id);
  assert.equal(audit.actor_user_id,'QA-ADMIN');assert.ok(audit.created_at);
  const payload=JSON.parse(audit.payload_json);assert.equal(payload.before.start,job.dateTime);assert.equal(payload.after.start,changed.dateTime);
  await app.json('/api/requests',{method:'PUT',body:{...job,dateTime:`${date}T12:00`,clientNotified:true}},409);
  const legacy={...changed,description:'Только описание'};delete legacy.clientVisitConfirmed;
  assert.equal((await app.json('/api/requests',{method:'PUT',body:legacy})).item.clientVisitConfirmed,true);
});

test('CLIENT-02 pending proposal leaves the old assignment active; only its complete approvals publish with actor and both schedules',async()=>{
  const [job]=await setup();unavailableOriginal();const plan=await calculate();
  assert.equal(plan.clientApprovals.length,1);assert.equal(plan.clientApprovals[0].before.workerId,'EMP-402');assert.equal(plan.clientApprovals[0].after.workerId,'EMP-390');
  assert.equal(app.db.prepare('SELECT assignee_worker_id FROM work_orders WHERE id=?').get(job.id).assignee_worker_id,'EMP-402');
  assert.deepEqual((await app.json(`/api/planning?date=${date}`)).result.clientApprovals,plan.clientApprovals);
  await publish(plan,undefined,409);await publish(plan,['unknown'],409);await publish(plan,[...acknowledgements(plan),...acknowledgements(plan)],400);
  assert.equal(app.db.prepare("SELECT COUNT(*) n FROM audit_events WHERE action='client_notified'").get().n,0);
  await publish(plan,acknowledgements(plan));
  assert.equal(app.db.prepare('SELECT assignee_worker_id FROM work_orders WHERE id=?').get(job.id).assignee_worker_id,'EMP-390');
  const event=app.db.prepare("SELECT * FROM audit_events WHERE entity_id=? AND action='client_notified'").get(job.id);
  assert.equal(event.actor_user_id,'QA-ADMIN');assert.equal(JSON.parse(event.payload_json).planId,plan.planId);
  assert.equal((await app.json(`/api/planning?date=${date}`)).result.status,'published');
});

test('CLIENT-03 partial approvals and approvals from an older draft cannot publish a replacement draft',async()=>{
  await setup(2);unavailableOriginal();const old=await calculate(),plan=await calculate();
  assert.equal(plan.clientApprovals.length,2);
  await publish(plan,acknowledgements(old),409);await publish(plan,acknowledgements(plan).slice(0,1),409);
  app.db.exec("UPDATE workers SET transport_details='Изменено' WHERE id='EMP-390'; UPDATE work_orders SET description='Изменено' WHERE status='assigned'");
  await publish(plan,acknowledgements(plan),409);
  assert.equal(app.db.prepare("SELECT COUNT(*) n FROM audit_events WHERE action='client_notified'").get().n,0);
});

test('CLIENT-04 removing a confirmed visit excluded for missing input also requires approval',async()=>{
  const [job]=await setup();app.db.prepare('UPDATE work_orders SET client_window_start=NULL,client_window_end=NULL WHERE id=?').run(job.id);
  const plan=await calculate();assert.equal(plan.unassigned.length,1);assert.equal(plan.clientApprovals[0].after.workerId,null);
  await publish(plan,[],409);await publish(plan,acknowledgements(plan));
  assert.equal(app.db.prepare('SELECT assignee_worker_id FROM work_orders WHERE id=?').get(job.id).assignee_worker_id,null);
});

test('CLIENT-05 a status race at publication rolls back acknowledgements and preserves protected work',async()=>{
  const [job]=await setup();unavailableOriginal();const plan=await calculate();const original=app.database.batch;
  let once=true;app.database.batch=async statements=>{if(once){once=false;app.db.prepare("UPDATE work_orders SET status='en_route' WHERE id=?").run(job.id);}return original(statements);};
  try {await publish(plan,acknowledgements(plan),409);} finally {app.database.batch=original;}
  const current=app.db.prepare('SELECT status,assignee_worker_id FROM work_orders WHERE id=?').get(job.id);
  assert.equal(current.status,'en_route');assert.equal(current.assignee_worker_id,'EMP-402');
  assert.equal(app.db.prepare("SELECT COUNT(*) n FROM audit_events WHERE action='client_notified'").get().n,0);
  assert.equal(app.db.prepare('SELECT status FROM route_plans WHERE id=?').get(plan.planId).status,'draft');
});

test('CLIENT-06 omitted confirmation is false for new jobs and completed acceptance is a separate state',async()=>{
  const [job]=await setup();app.db.prepare("UPDATE work_orders SET status='completed',client_visit_confirmed=0 WHERE id=?").run(job.id);
  const completed=(await app.json('/api/requests')).items.find(j=>j.id===job.id);
  const accepted=(await app.json('/api/requests',{method:'PUT',body:{...completed,status:'confirmed'}})).item;
  assert.equal(accepted.status,'confirmed');assert.equal(accepted.clientVisitConfirmed,false);
});
