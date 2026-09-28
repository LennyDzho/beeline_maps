import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import ts from "typescript";

const dataUrl = code => `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;
async function moduleSource(file) {
  return ts.transpileModule(await readFile(new URL(file, import.meta.url), "utf8"), {
    compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext},
  }).outputText;
}

// Invoke the actual initializer's seed function with its actual catalogs, but
// capture its SQL. No Cloudflare process, local D1, credentials or user data.
let source = await moduleSource("../db/domain-storage.ts");
for (const [alias, file] of Object.entries({
  "@/app/admin/role-data":"../app/admin/role-data.ts",
  "@/app/admin/user-data":"../app/admin/user-data.ts",
  "@/app/admin/work-type-data":"../app/admin/work-type-data.ts",
  "@/app/resources/resource-data":"../app/resources/resource-data.ts",
  "@/app/lib/planned-duration":"../app/lib/planned-duration.ts",
})) source = source.replaceAll(`from "${alias}"`, `from "${dataUrl(await moduleSource(file))}"`);
for(const name of ['0009_wide_morbius','0010_nifty_stature']) {
  const sql=await readFile(new URL(`../drizzle/${name}.sql`,import.meta.url),'utf8');
  source=source.replace(`from "@/drizzle/${name}.sql?raw"`,`from "${dataUrl(`export default ${JSON.stringify(sql)};`)}"`);
}
source = source.replace(/from "@\/drizzle\/[^"\n]+"/gu, `from "${dataUrl('export default "";')}"`);
source = source.replace('from "@/auth/storage"', `from "${dataUrl('export function ensureAuthSchema(){throw new Error("Not allowed in seed test")} export function getBootstrapCredentials(){return null}')}"`);
const {seedDomain,initializeEmptyMobileDomain} = await import(dataUrl(source + "\nexport {seedDomain,initializeEmptyMobileDomain};"));

test("restarting seed does not overwrite orders, addresses, worker settings or revisions", async () => {
  const captured = [];
  await seedDomain({
    prepare(sql) { return { async first() { return null; }, bind(...values) {return {sql,values, async all() { return { results: [] }; }};}}; },
    async batch(statements) { captured.push(...statements); },
  }, {id:"ADMIN"});
  assert.ok(captured.length > 50, "real seed catalogs were loaded");
  assert.ok(captured.every(s=>/^\s*INSERT OR IGNORE\b/iu.test(s.sql)), "startup seed must be insert-only");
  const tables = ["work_orders","service_objects","workers"];
  const relevant = captured.filter(s=>tables.some(table=>new RegExp(`\\bINTO ${table}\\b`,"u").test(s.sql)));
  const db = new DatabaseSync(":memory:");
  try {
    for (const table of tables) {
      const first = relevant.find(s=>s.sql.includes(`INTO ${table}`));
      const fields = first.sql.match(/\(([^)]+)\)\s*VALUES/su)[1].split(",").map(c=>c.trim());
      db.exec(`CREATE TABLE ${table} (${fields.map(c=>`${c} ${c==="id"?"TEXT PRIMARY KEY":"TEXT"}`).join(",")}${table==="work_orders"?",revision INTEGER DEFAULT 0":""})`);
    }
    db.exec("CREATE TRIGGER revision_after_update AFTER UPDATE ON work_orders WHEN NEW.revision=OLD.revision BEGIN UPDATE work_orders SET revision=OLD.revision+1 WHERE id=NEW.id; END;");
    for (const s of relevant) db.prepare(s.sql).run(...s.values);
    db.exec(`UPDATE work_orders SET address_snapshot='Адрес диспетчера',latitude_snapshot='12',scheduled_end='2026-09-08T12:30',status='paused';
      UPDATE service_objects SET address='Исправленный объект',latitude='13';
      UPDATE workers SET start_address='Другой старт',work_schedule_id=NULL,shift_status='off_shift';`);
    const inventory = () => tables.map(table=>db.prepare(`SELECT * FROM ${table} ORDER BY id`).all());
    const before = inventory();
    for (const s of relevant) db.prepare(s.sql).run(...s.values);
    assert.deepEqual(inventory(),before);
  } finally {db.close();}
});

test("restarting seed preserves renamed or disabled catalogues and removed worker skills and qualifications", async () => {
  const db = new DatabaseSync(":memory:");
  async function capture(existingWorkerIds = []) {
    const statements = [];
    await seedDomain({
      prepare(sql) { return { async first() { return null; }, bind(...values) { return { sql, values, async all() { return { results: existingWorkerIds.map(id => ({ id })) }; } }; } }; },
      async batch(items) { statements.push(...items); },
    }, { id: "ADMIN" });
    return statements.filter(s => /\bINTO (workers|qualifications|worker_qualifications|skills|worker_skills)\b/u.test(s.sql));
  }
  try {
    const first = await capture();
    for (const table of ["workers", "qualifications", "skills"]) {
      const statement = first.find(s => s.sql.includes(`INTO ${table}`));
      const columns = statement.sql.match(/\(([^)]+)\)\s*VALUES/su)[1].split(",").map(c => c.trim());
      db.exec(`CREATE TABLE ${table} (${columns.map(c => `${c} ${c === "id" ? "TEXT PRIMARY KEY" : "TEXT"}`).join(",")})`);
    }
    db.exec("CREATE TABLE worker_qualifications (worker_id TEXT, qualification_id TEXT, status TEXT, document_number TEXT DEFAULT '', expires_at TEXT, PRIMARY KEY(worker_id,qualification_id))");
    db.exec("CREATE TABLE worker_skills (worker_id TEXT, skill_id TEXT, level TEXT, confirmed_at TEXT, PRIMARY KEY(worker_id,skill_id))");
    for (const s of first) db.prepare(s.sql).run(...s.values);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM worker_qualifications WHERE worker_id='EMP-402'").get().n, 2);
    db.exec(`UPDATE qualifications SET name='Изменённый допуск',description='Новое описание' WHERE id='QUAL-2';
      UPDATE qualifications SET active=0 WHERE id='QUAL-6';
      UPDATE worker_qualifications SET document_number='DOC-42',expires_at='2027-01-01',status='suspended' WHERE worker_id='EMP-402' AND qualification_id='QUAL-2';
      DELETE FROM worker_qualifications WHERE worker_id='EMP-402' AND qualification_id='QUAL-3';
      UPDATE skills SET name='Изменённый навык',description='Новое описание навыка' WHERE id='SKILL-1';
      UPDATE skills SET active=0 WHERE id='SKILL-5';
      UPDATE worker_skills SET level='expert',confirmed_at='2026-02-01' WHERE worker_id='EMP-402' AND skill_id='SKILL-1';
      DELETE FROM worker_skills WHERE worker_id='EMP-402' AND skill_id='SKILL-6';`);
    const inventory = () => [db.prepare("SELECT * FROM qualifications ORDER BY id").all(), db.prepare("SELECT * FROM worker_qualifications ORDER BY worker_id,qualification_id").all(), db.prepare("SELECT * FROM skills ORDER BY id").all(), db.prepare("SELECT * FROM worker_skills ORDER BY worker_id,skill_id").all()];
    const before = inventory();
    const existingIds = db.prepare("SELECT id FROM workers").all().map(row => row.id);
    for (const s of await capture(existingIds)) db.prepare(s.sql).run(...s.values);
    assert.deepEqual(inventory(), before);
  } finally { db.close(); }
});

test("an installed dataset prevents the legacy seed from recreating any demo row", async () => {
  let batches = 0;
  await seedDomain({ prepare() { return { async first() { return { version: "beeline-app-v1" }; } }; }, async batch() { batches++; } }, { id: "ADMIN" });
  assert.equal(batches, 0);
});

test('COLD-02 legacy domain data blocks automatic reconstruction before any write',async()=>{
  const db=new DatabaseSync(':memory:');
  try {
    for(const table of ['work_orders','workers','work_types','service_objects','resources'])db.exec(`CREATE TABLE ${table}(id TEXT)`);
    db.exec("INSERT INTO workers VALUES('existing-worker')");
    let writes=0;
    const database={prepare(sql){return {async first(){return db.prepare(sql).get() ?? null;},async run(){writes++;}};},async batch(){writes++;}};
    await assert.rejects(initializeEmptyMobileDomain(database,'ADMIN'),/0009\/0010/);
    assert.equal(writes,0);assert.equal(db.prepare('SELECT id FROM workers').get().id,'existing-worker');
  } finally{db.close();}
});

test('COLD-03 population before reconstruction rolls back DDL and its marker; retry succeeds with foreign keys enabled',async()=>{
  const db=new DatabaseSync(':memory:');
  try {
    const directory=new URL('../drizzle/',import.meta.url);
    for(const file of (await readdir(directory)).filter(name=>/^000[0-8]_.+\.sql$/.test(name)).sort())db.exec(await readFile(new URL(file,directory),'utf8'));
    db.exec("CREATE TABLE domain_schema_migrations(name TEXT PRIMARY KEY,applied_at TEXT NOT NULL); PRAGMA foreign_keys=ON");
    db.exec("INSERT INTO users(id,email,display_name,role,password_salt,password_hash,password_iterations,status,created_at,updated_at) VALUES('ADMIN','cold@example.invalid','Администратор','administrator','salt','hash',1,'active','now','now')");
    let race=true;
    const database={
      prepare(sql){return {values:[],bind(...values){this.values=values;return this;},async first(){return db.prepare(sql).get(...this.values) ?? null;},async all(){return {results:db.prepare(sql).all(...this.values)};},async run(){db.prepare(sql).run(...this.values);return {success:true};}};},
      async batch(statements){
        if(race){race=false;db.exec("INSERT INTO workers(id,organization_id,employee_number,full_name,phone,created_at,updated_at) VALUES('LATE','ORG-001','late','Новая бригада','','now','now')");}
        db.exec('SAVEPOINT cold_migration');
        try{for(const statement of statements)await statement.run();db.exec('RELEASE cold_migration');return [];}
        catch(error){db.exec('ROLLBACK TO cold_migration; RELEASE cold_migration');throw error;}
      },
    };
    await assert.rejects(initializeEmptyMobileDomain(database,'ADMIN'),/mobile_command_precondition/);
    assert.equal(db.prepare("SELECT sql FROM sqlite_master WHERE name='work_orders'").get().sql.includes("'paused'"),false);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM domain_schema_migrations WHERE name='0010_nifty_stature'").get().n,0);
    assert.equal(db.prepare('SELECT id FROM workers').get().id,'LATE');
    db.exec("DELETE FROM workers WHERE id='LATE'");await initializeEmptyMobileDomain(database,'ADMIN');
    assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys,1);
    assert.ok(db.prepare("SELECT sql FROM sqlite_master WHERE name='work_orders'").get().sql.includes("'paused'"));
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
  } finally{db.close();}
});
