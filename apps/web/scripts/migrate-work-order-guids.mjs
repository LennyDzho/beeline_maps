import assert from 'node:assert/strict';
import { DatabaseSync, backup } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { readFile, readdir, mkdir } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { gzipSync, gunzipSync } from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import ts from 'typescript';

const root = fileURLToPath(new URL('../', import.meta.url));
const quote = name => `"${name.replaceAll('"', '""')}"`;
export const isGuid = value => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
// Use the application's actual freshness expression, including all planner inputs.
const source = ts.transpileModule(await readFile(path.join(root, 'app/lib/server/planning/input-revisions.ts'), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText;
const { planningInputExpression } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
export { planningInputExpression };
const groupInput = `(SELECT json_group_array(json_array(scope.organization_id,json(${planningInputExpression})))
  FROM (SELECT value AS organization_id FROM json_each(g.organization_ids_json) ORDER BY value) scope)`;

function storedJson(text, transform) {
  const wrapper = JSON.parse(text);
  if (wrapper.storedPlanEncoding === 'gzip-base64/v1') {
    const value = JSON.parse(gunzipSync(Buffer.from(wrapper.data, 'base64')).toString('utf8'));
    return JSON.stringify({ ...wrapper, data: gzipSync(JSON.stringify(transform(value))).toString('base64') });
  }
  return JSON.stringify(transform(wrapper));
}

/** Offline, atomic data migration. No table reconstruction, deletion or FK disabling.
 * Source import manifests and mobile command fingerprints are immutable provenance.
 */
export function migrateWorkOrderGuids(db, { beforeCommit } = {}) {
  db.exec('PRAGMA foreign_keys=ON; BEGIN EXCLUSIVE');
  try {
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    const orders = db.prepare('SELECT * FROM work_orders ORDER BY id').all();
    const ids = new Map(orders.filter(row => !isGuid(row.id)).map(row => [row.id, randomUUID()]));
    if (!ids.size) { db.exec('COMMIT'); return { changed: false, migrated: 0 }; }
    const newIds = new Set(ids.values());
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(row => row.name);
    const counts = () => Object.fromEntries(tables.map(table => [table, db.prepare(`SELECT COUNT(*) n FROM ${quote(table)}`).get().n]));
    const beforeCounts = counts();
    const beforeNotifications = db.prepare('SELECT sequence,organization_id,kind,detail,created_at FROM dispatcher_notifications ORDER BY sequence').all();
    const triggers = db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND tbl_name='work_orders'").all();
    const snapshots = new Map(db.prepare(`SELECT ${planningInputExpression} AS snapshot,scope.organization_id FROM (SELECT id AS organization_id FROM organizations) scope`).all().map(r => [r.organization_id, r.snapshot]));
    const planRows = db.prepare('SELECT * FROM route_plans').all();
    const groupRows = db.prepare(`SELECT *,${groupInput} AS current_revision FROM route_plan_groups g`).all();

    // JSON data uses explicit ID properties; labels, numbers, comments and addresses stay intact.
    const idKeys = new Set(['jobId','jobIds','protectedJobIds','orderId','orderIds','requestId','requestIds','workOrderId','entityId']);
    function references(value, key = '') {
      if (typeof value === 'string') return idKeys.has(key) ? ids.get(value) ?? value : value;
      if (Array.isArray(value)) return value.map(item => references(item, key));
      if (value && typeof value === 'object') {
        const result = Object.fromEntries(Object.entries(value).map(([k,v]) => [k,references(v,k)]));
        if (typeof value.jobId === 'string' && ids.has(value.jobId) && typeof value.id === 'string' && value.id.endsWith(`:${value.jobId}`)) {
          result.id = value.id.slice(0,-value.jobId.length) + ids.get(value.jobId);
        }
        return result;
      }
      return value;
    }
    // Snapshots store row arrays sorted by the IDs; keep their order canonical after rekeying.
    function revision(value) {
      if (typeof value === 'string') {
        if (ids.has(value)) return ids.get(value);
        if (value.startsWith('[')) { try { return JSON.stringify(revision(JSON.parse(value))); } catch { /* ordinary string */ } }
        return value;
      }
      if (!Array.isArray(value)) return value;
      const result = value.map(revision);
      if (result.some(row => Array.isArray(row) && newIds.has(row[0]))) {
        result.sort((a,b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
      }
      return result;
    }
    db.exec('PRAGMA defer_foreign_keys=ON');
    // Changing an ID is not a work-order edit or a status event.
    for (const trigger of triggers) db.exec(`DROP TRIGGER ${quote(trigger.name)}`);
    db.exec('CREATE TEMP TABLE order_guid_map(old_id TEXT PRIMARY KEY,new_id TEXT UNIQUE NOT NULL)');
    const insertMap = db.prepare('INSERT INTO order_guid_map VALUES (?,?)');
    for (const pair of ids) insertMap.run(...pair);
    for (const table of tables) {
      for (const fk of db.prepare(`PRAGMA foreign_key_list(${quote(table)})`).all().filter(fk => fk.table === 'work_orders' && fk.to === 'id')) {
        db.exec(`UPDATE ${quote(table)} SET ${quote(fk.from)}=(SELECT new_id FROM order_guid_map WHERE old_id=${quote(table)}.${quote(fk.from)})
          WHERE ${quote(fk.from)} IN (SELECT old_id FROM order_guid_map)`);
      }
    }
    db.exec('UPDATE work_orders SET id=(SELECT new_id FROM order_guid_map WHERE old_id=work_orders.id) WHERE id IN (SELECT old_id FROM order_guid_map)');
    db.exec("UPDATE audit_events SET entity_id=(SELECT new_id FROM order_guid_map WHERE old_id=entity_id) WHERE entity_type='work_order' AND entity_id IN (SELECT old_id FROM order_guid_map)");
    for (const row of db.prepare('SELECT id,payload_json FROM audit_events').all()) {
      const payload = storedJson(row.payload_json, references);
      if (payload !== row.payload_json) db.prepare('UPDATE audit_events SET payload_json=? WHERE id=?').run(payload,row.id);
    }
    for (const row of db.prepare('SELECT worker_id,activity_revision FROM worker_planning_availability').all()) {
      db.prepare('UPDATE worker_planning_availability SET activity_revision=? WHERE worker_id=?').run(JSON.stringify(revision(JSON.parse(row.activity_revision))),row.worker_id);
    }
    const current = new Map(db.prepare(`SELECT ${planningInputExpression} AS snapshot,scope.organization_id FROM (SELECT id AS organization_id FROM organizations) scope`).all().map(r => [r.organization_id,r.snapshot]));
    function rewritePlans(table, rows) {
      for (const row of rows) {
        const oldCurrent = table === 'route_plans' ? snapshots.get(row.organization_id) : row.current_revision;
        const newCurrent = table === 'route_plans' ? current.get(row.organization_id) : db.prepare(`SELECT ${groupInput} AS snapshot FROM route_plan_groups g WHERE id=?`).get(row.id).snapshot;
        const changeRevision = text => text === null ? null : text === oldCurrent ? newCurrent : JSON.stringify(revision(JSON.parse(text)));
        const input = changeRevision(row.input_revision_json), published = changeRevision(row.published_revision_json);
        assert.equal(input === newCurrent, row.input_revision_json === oldCurrent, 'Input freshness must not change');
        assert.equal(published === newCurrent, row.published_revision_json === oldCurrent, 'Published freshness must not change');
        db.prepare(`UPDATE ${table} SET result_json=?,input_revision_json=?,published_revision_json=? WHERE id=?`)
          .run(row.result_json === null ? null : storedJson(row.result_json,references),input,published,row.id);
      }
    }
    rewritePlans('route_plans',planRows); rewritePlans('route_plan_groups',groupRows);
    for (const trigger of triggers) db.exec(trigger.sql);
    db.exec('DROP TABLE order_guid_map');
    assert.deepEqual(counts(),beforeCounts,'Every table must retain its row count');
    for (const old of orders) assert.deepEqual({...db.prepare('SELECT * FROM work_orders WHERE id=?').get(ids.get(old.id) ?? old.id)},{...old,id:ids.get(old.id) ?? old.id},'Only the primary key may change');
    assert.deepEqual(db.prepare('SELECT sequence,organization_id,kind,detail,created_at FROM dispatcher_notifications ORDER BY sequence').all(),beforeNotifications);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
    beforeCommit?.();
    db.exec('COMMIT');
    return { changed:true,migrated:ids.size,orders:orders.length,plans:planRows.length,groups:groupRows.length };
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

async function serverRunning() {
  return new Promise(resolve => {
    const socket=createConnection({host:'127.0.0.1',port:3000});socket.setTimeout(1000);
    const finish=value=>{socket.destroy();resolve(value);};
    socket.once('connect',()=>finish(true));socket.once('error',()=>finish(false));socket.once('timeout',()=>finish(true));
  });
}
async function main() {
  const apply=process.argv.includes('--apply');
  if (apply && await serverRunning()) throw new Error('Stop the local web server before --apply. No data changed.');
  const folder=path.join(root,'.wrangler/state/v3/d1/miniflare-D1DatabaseObject');
  const files=(await readdir(folder)).filter(name=>/^[a-f0-9]{64}\.sqlite$/u.test(name));
  assert.equal(files.length,1,'Expected exactly one application database');
  const sourcePath=path.join(folder,files[0]),output=path.join(root,'.tmp/work-order-guids');
  await mkdir(output,{recursive:true});
  const stamp=`${new Date().toISOString().replaceAll(':','-')}-${randomUUID()}`;
  const backupPath=path.join(output,`${stamp}-backup.sqlite`),validationPath=path.join(output,`${stamp}-validation.sqlite`);
  const source=new DatabaseSync(sourcePath,{readOnly:true});
  try { await backup(source,backupPath);await backup(source,validationPath); } finally {source.close();}
  const validation=new DatabaseSync(validationPath);
  try { console.log('copyValidation',JSON.stringify(migrateWorkOrderGuids(validation))); } finally {validation.close();}
  if (apply) {
    const live=new DatabaseSync(sourcePath);
    try {console.log('applied',JSON.stringify(migrateWorkOrderGuids(live)));} finally {live.close();}
  }
  console.log(JSON.stringify({applied:apply,backupPath,validationPath}));
}
if(process.argv[1] && import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)await main();
