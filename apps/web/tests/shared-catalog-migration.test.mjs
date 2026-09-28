import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';

test('CAT-MIG-01 shared identities preserve historical norms, worker documents, assignments and fresh/stale plan state',async()=>{
  const db=new DatabaseSync(':memory:');
  try {
    for(const file of (await readdir(new URL('../drizzle/',import.meta.url))).filter(f=>/^\d+_.*\.sql$/.test(f)&&f<'0025').sort())db.exec(await readFile(new URL(`../drizzle/${file}`,import.meta.url),'utf8'));
    db.exec(`PRAGMA foreign_keys=ON;
      INSERT INTO users(id,email,display_name,role,password_salt,password_hash,password_iterations,status,created_at,updated_at) VALUES ('U','u@example.invalid','User','administrator','x','x',1,'active','now','now');
      INSERT INTO work_types(id,organization_id,code,name,created_at,updated_at) VALUES ('TA','ORG-001','TA','Работа','now','now'),('TB','ORG-002','TB','Работа','now','now');
      INSERT INTO work_type_versions(id,work_type_id,version,status,planned_duration_minutes,created_at) VALUES ('VA','TA',1,'published',20,'now'),('VB','TB',1,'published',70,'now');
      INSERT INTO work_categories(id,organization_id,name,created_at,updated_at) VALUES ('CA','ORG-001','Подключение','now','now'),('CB','ORG-002','Подключение','now','now');
      INSERT INTO category_work_types VALUES ('CA','TA'),('CB','TB');
      INSERT INTO workers(id,organization_id,employee_number,full_name,phone,created_at,updated_at) VALUES ('W','ORG-002','W','Бригада','','now','now');
      INSERT INTO qualifications(id,organization_id,code,name) VALUES ('QA','ORG-001','QA','Допуск'),('QB','ORG-002','QB','Допуск');
      INSERT INTO worker_qualifications(worker_id,qualification_id,document_number,issued_at,expires_at,status) VALUES ('W','QB','DOC-2','2026-01-01','2027-01-01','valid');
      INSERT INTO work_type_version_qualifications VALUES ('VB','QB');
      INSERT INTO worker_work_competencies VALUES ('W','CB','TB');
      INSERT INTO work_orders(id,organization_id,number,work_type_version_id,category_id,assignee_worker_id,created_by_user_id,status,service_duration_minutes,scheduled_start,scheduled_end,address_snapshot,created_at,updated_at) VALUES ('J','ORG-002','J','VB','CB','W','U','assigned',70,'2026-08-17T10:00','2026-08-17T11:10','Адрес','now','now');
      INSERT INTO route_plans(id,organization_id,service_date,status,optimizer_version,created_by_user_id,created_at,updated_at,result_json) VALUES ('P','ORG-002','2026-08-17','published','test','U','now','now','{"typeId":"TB","versionId":"VB"}'),('S','ORG-001','2026-08-17','published','test','U','now','now','{}');
    `);
    const migration=await readFile(new URL('../drizzle/0025_shared_work_catalog.sql',import.meta.url),'utf8');
    const oldExpression=migration.split('--> statement-breakpoint')[0].split('END)=')[1].trim().replace(/;$/,'');
    const oldInput=db.prepare(`SELECT ${oldExpression} snapshot FROM (SELECT 'ORG-002' AS organization_id) scope`).get().snapshot;
    db.prepare("UPDATE route_plans SET published_revision_json=? WHERE id='P'").run(oldInput);
    db.exec("UPDATE route_plans SET published_revision_json='stale' WHERE id='S'; BEGIN");
    db.exec(migration);db.exec('COMMIT');
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM work_types').get().n,1);
    assert.deepEqual({...db.prepare("SELECT work_type_version_id,category_id,assignee_worker_id,service_duration_minutes FROM work_orders WHERE id='J'").get()},{work_type_version_id:'VB',category_id:'CA',assignee_worker_id:'W',service_duration_minutes:70});
    assert.equal(db.prepare("SELECT planned_duration_minutes FROM work_type_versions WHERE id='VB'").get().planned_duration_minutes,70);
    assert.deepEqual({...db.prepare("SELECT qualification_id,document_number,expires_at FROM worker_qualifications WHERE worker_id='W'").get()},{qualification_id:'QA',document_number:'DOC-2',expires_at:'2027-01-01'});
    assert.equal(db.prepare("SELECT result_json FROM route_plans WHERE id='P'").get().result_json,'{"typeId":"TA","versionId":"VB"}');
    // Check the snapshot format of migration 0025 itself; later settings migrations intentionally supersede it.
    const update=migration.split('--> statement-breakpoint').find(sql=>sql.trim().startsWith('UPDATE route_plans SET input_revision_json='));
    const planningInputExpression=update.slice(update.indexOf('(SELECT json_array(')+8,update.indexOf(' FROM (SELECT route_plans.organization_id'));
    const actual=db.prepare(`SELECT ${planningInputExpression} snapshot FROM (SELECT 'ORG-002' AS organization_id) scope`).get().snapshot;
    assert.ok(actual===db.prepare("SELECT published_revision_json FROM route_plans WHERE id='P'").get().published_revision_json);
    assert.equal(db.prepare("SELECT published_revision_json FROM route_plans WHERE id='S'").get().published_revision_json,'stale');
  }finally{db.close();}
});
