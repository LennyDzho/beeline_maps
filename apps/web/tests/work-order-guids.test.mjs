import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { gzipSync,gunzipSync } from 'node:zlib';
import { isolatedWorker } from './helpers/isolated-worker.mjs';
import { migrateWorkOrderGuids,isGuid,planningInputExpression } from '../scripts/migrate-work-order-guids.mjs';

test('GUID migration is atomic, retains links, public numbers, read states and compressed plans, and can be rerun',async t=>{
  const app=await isolatedWorker();t.after(()=>app.close());const db=app.db;
  const original=db.prepare("SELECT * FROM work_orders WHERE id='ORD-9021'").get();
  const clone={...original,id:randomUUID(),organization_id:'ORG-002'};
  db.prepare(`INSERT INTO work_orders (${Object.keys(clone).join(',')}) VALUES (${Object.keys(clone).map(()=>'?').join(',')})`).run(...Object.values(clone));
  db.exec("UPDATE work_orders SET status='assigned' WHERE id='ORD-9021'");
  const feed=await app.json('/api/notifications');
  await app.json('/api/notifications',{method:'PUT',body:{action:'read',sequences:[feed.latest]}});
  const readBefore=db.prepare('SELECT * FROM dispatcher_notification_reads').all();
  const reportBefore=db.prepare('SELECT * FROM work_reports').all();
  const mediaBefore=db.prepare('SELECT * FROM report_media').all();
  const snapshot=()=>db.prepare(`SELECT ${planningInputExpression} value FROM (SELECT 'ORG-001' organization_id) scope`).get().value;
  const result={routes:[{visits:[{jobId:original.id,label:original.number}]}],protectedJobIds:[original.id],clientApprovals:[{id:`PLAN:${original.id}`,jobId:original.id}],departments:[{jobIds:[original.id]}]};
  const compressed=JSON.stringify({storedPlanEncoding:'gzip-base64/v1',data:gzipSync(JSON.stringify(result)).toString('base64')});
  db.prepare("INSERT INTO route_plans(id,organization_id,service_date,status,created_by_user_id,created_at,updated_at,input_revision_json,result_json) VALUES ('PLAN','ORG-001','2026-08-24','draft','QA-ADMIN','now','now',?,?)").run(snapshot(),compressed);
  db.prepare("INSERT INTO route_plans(id,organization_id,service_date,status,created_by_user_id,created_at,updated_at,input_revision_json,result_json) VALUES ('STALE','ORG-001','2026-08-23','draft','QA-ADMIN','now','now','[]',?)").run(JSON.stringify(result));
  db.exec("INSERT INTO route_stops(id,route_plan_id,work_order_id,worker_id,sequence,planned_start,created_at) VALUES ('STOP','PLAN','ORD-9021','EMP-402',1,'2026-08-24T09:00','now')");
  db.prepare("INSERT INTO route_plan_groups(id,service_date,status,organization_ids_json,member_plans_json,input_revision_json,result_json,created_by_user_id,created_at,updated_at) VALUES ('GROUP','2026-08-24','draft','[\"ORG-001\"]','[]',?,?,'QA-ADMIN','now','now')").run(JSON.stringify([['ORG-001',JSON.parse(snapshot())]]),compressed);
  db.prepare("INSERT INTO audit_events(id,organization_id,entity_type,entity_id,action,payload_json,created_at) VALUES ('AUDIT','ORG-001','work_order',?,'test',?,'now')").run(original.id,JSON.stringify({jobId:original.id,comment:original.id}));
  const revisionBefore=db.prepare("SELECT revision FROM work_orders WHERE id=?").get(original.id).revision;
  assert.throws(()=>migrateWorkOrderGuids(db,{beforeCommit(){throw new Error('injected failure');}}),/injected failure/);
  assert.ok(db.prepare('SELECT 1 FROM work_orders WHERE id=?').get(original.id));
  assert.equal(db.prepare("SELECT result_json FROM route_plans WHERE id='PLAN'").get().result_json,compressed);
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE name='work_orders_increment_revision'").get());
  const summary=migrateWorkOrderGuids(db);assert.equal(summary.migrated,8);
  const order=db.prepare('SELECT * FROM work_orders WHERE organization_id=? AND number=?').get(original.organization_id,original.number);
  assert.ok(isGuid(order.id));assert.equal(order.revision,revisionBefore);
  assert.equal(db.prepare('SELECT id FROM work_orders WHERE organization_id=? AND number=?').get('ORG-002',original.number).id,clone.id);
  assert.equal(db.prepare("SELECT work_order_id FROM route_stops WHERE id='STOP'").get().work_order_id,order.id);
  const plan=db.prepare("SELECT * FROM route_plans WHERE id='PLAN'").get();
  assert.equal(plan.input_revision_json,snapshot());
  assert.notEqual(db.prepare("SELECT input_revision_json FROM route_plans WHERE id='STALE'").get().input_revision_json,snapshot());
  for(const table of ['route_plans','route_plan_groups']) {
    const row=db.prepare(`SELECT result_json FROM ${table} WHERE id=?`).get(table==='route_plans'?'PLAN':'GROUP');
    const decoded=JSON.parse(gunzipSync(Buffer.from(JSON.parse(row.result_json).data,'base64')).toString());
    assert.equal(decoded.routes[0].visits[0].jobId,order.id);assert.equal(decoded.routes[0].visits[0].label,original.number);
    assert.equal(decoded.clientApprovals[0].id,`PLAN:${order.id}`);assert.deepEqual(decoded.departments[0].jobIds,[order.id]);
  }
  assert.equal(db.prepare("SELECT input_revision_json FROM route_plan_groups WHERE id='GROUP'").get().input_revision_json,JSON.stringify([['ORG-001',JSON.parse(snapshot())]]));
  const audit=db.prepare("SELECT * FROM audit_events WHERE id='AUDIT'").get();
  assert.equal(audit.entity_id,order.id);assert.deepEqual(JSON.parse(audit.payload_json),{jobId:order.id,comment:original.id});
  assert.deepEqual(db.prepare('SELECT * FROM dispatcher_notification_reads').all(),readBefore);
  assert.deepEqual(db.prepare('SELECT * FROM report_media').all(),mediaBefore);
  for(const report of reportBefore) {
    const next=db.prepare('SELECT * FROM work_reports WHERE id=?').get(report.id);
    assert.ok(isGuid(next.work_order_id));assert.deepEqual({...next,work_order_id:report.work_order_id},{...report});
  }
  const after=await app.json('/api/notifications');assert.equal(after.items[0].orderId,order.id);assert.equal(after.items[0].read,true);
  assert.equal(after.items[0].title,`Заявка № ${original.number} · Назначена`);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
  assert.deepEqual(migrateWorkOrderGuids(db),{changed:false,migrated:0});
  db.prepare("UPDATE work_orders SET status='in_progress' WHERE id=?").run(order.id);
  assert.equal(db.prepare('SELECT revision FROM work_orders WHERE id=?').get(order.id).revision,revisionBefore+1);
  assert.equal((await app.json('/api/notifications')).items[0].title,`Заявка № ${original.number} · В работе`);
});
