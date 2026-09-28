import assert from 'node:assert/strict';
import test from 'node:test';
import {isolatedWorker} from './helpers/isolated-worker.mjs';

test('COLD-01 an empty domain starts from authentication alone with foreign keys enabled and all runtime migrations',async t=>{
  const app=await isolatedWorker({coldStart:true});t.after(()=>app.close());
  assert.equal(app.db.prepare('PRAGMA foreign_keys').get().foreign_keys,1);
  assert.deepEqual(app.db.prepare('PRAGMA foreign_key_check').all(),[]);
  assert.ok(app.db.prepare("SELECT sql FROM sqlite_master WHERE name='work_orders'").get().sql.includes("'paused'"));
  const migrations=app.db.prepare('SELECT name FROM domain_schema_migrations ORDER BY name').all().map(row=>row.name);
  for(const name of ['0009_wide_morbius','0010_nifty_stature','0011_regional_scheduling','0022_common_department_plans'])assert.ok(migrations.includes(name),name);
  const data=await app.json('/api/planning/workspace');assert.equal(data.departments.length,2);assert.ok(data.items.length>0);
  const row=app.db.prepare("SELECT id,revision FROM work_orders WHERE status='assigned' LIMIT 1").get();
  app.db.prepare("UPDATE work_orders SET status='paused' WHERE id=?").run(row.id);
  assert.equal(app.db.prepare('SELECT revision FROM work_orders WHERE id=?').get(row.id).revision,row.revision+1);
  const count=app.db.prepare('SELECT COUNT(*) n FROM work_orders').get().n;
  await app.json('/api/admin/bootstrap');assert.equal(app.db.prepare('SELECT COUNT(*) n FROM work_orders').get().n,count);
});
