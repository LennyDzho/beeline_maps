import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import test from "node:test";
import ts from "typescript";
import { manifest, importBeelineIntoEmptyDatabase, beelinePreview } from "./helpers/beeline-import.mjs";

const dataUrl = code => `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;
const transpile = async file => ts.transpileModule(await readFile(new URL(file, import.meta.url), "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
let mobileSource = await transpile("../app/lib/server/mobile/state.ts");
const regionalUrl = dataUrl(await transpile("../../../packages/provider-contracts/src/regional-time.ts"));
const schedulingUrl = dataUrl((await transpile("../app/lib/request-scheduling.ts")).replace('from "./regional-time"', `from "${regionalUrl}"`));
mobileSource = mobileSource.replace('from "./errors"', `from "${dataUrl(await transpile("../app/lib/server/mobile/errors.ts"))}"`)
  .replace('from "../../regional-time"', `from "${regionalUrl}"`)
  .replace('from "../../request-scheduling"', `from "${schedulingUrl}"`)
  .replace('from "../../report-requirements"', `from "${dataUrl(await transpile("../app/lib/report-requirements.ts"))}"`);
const { mobileState } = await import(dataUrl(mobileSource));
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;

async function fixture() {
  const db = new DatabaseSync(":memory:");
  for (const name of (await readdir(new URL("../drizzle/", import.meta.url))).filter(name => /^\d+_.+\.sql$/.test(name)).sort()) db.exec(await readFile(new URL(`../drizzle/${name}`, import.meta.url), "utf8"));
  db.exec("PRAGMA foreign_keys=ON");
  // Legacy 0004 creates three empty organizations, not application records.
  db.exec("DELETE FROM organizations");
  db.exec("INSERT INTO users (id,email,display_name,role,password_salt,password_hash,password_iterations,status,created_at,updated_at) VALUES ('ADMIN','admin@example.invalid','Admin','administrator','test','test',1,'active','now','now')");
  const state = { db, count: 0, failAfter: Infinity, database: {
    prepare(sql) { return { sql, values: [], bind(...values) { this.values = values; return this; }, async first() { return db.prepare(sql).get(...this.values) ?? null; }, async all() { return {results:db.prepare(sql).all(...this.values)}; }, async run() { return db.prepare(sql).run(...this.values); } }; },
    async batch(statements) {
      state.count = 0; db.exec("BEGIN");
      try { for (const statement of statements) { if (++state.count === state.failAfter) throw new Error("injected failure"); await statement.run(); } db.exec("COMMIT"); }
      catch (error) { db.exec("ROLLBACK"); throw error; }
    },
  } };
  return state;
}

test("IMP-01 prepared manifest integrity, exact counts, full addresses, scoped HD, no false slash splits", () => {
  const { contentHash, ...body } = manifest;
  assert.equal(createHash("sha256").update(JSON.stringify(canonical(body))).digest("hex"), contentHash);
  const data = beelinePreview();
  assert.deepEqual([data.counts.jobs, data.counts.newJobs, data.counts.workers, data.counts.compositeJobs], [204, 203, 35, 14]);
  assert.deepEqual(data.divisions.map(item => [item.jobs, item.newJobs, item.workers]), [[66, 66, 12], [82, 81, 12], [56, 56, 11]]);
  assert.equal(data.jobs.some(item => item.number === "24482"), false);
  assert.equal(data.jobs.find(item => item.number === "11872").status, "completed");
  for (const job of manifest.jobs) {
    const required = job.workTypeIds;
    assert.ok(manifest.workers.some(worker => worker.divisionId === job.divisionId && required.every(id => worker.competencies.some(c => c.categoryId === job.categoryId && c.workTypeId === id))));
    assert.equal(job.entrance, ""); assert.equal(job.intercom, "");
    if (job.apartment) assert.ok(job.address.includes(`кв. ${job.apartment}`));
    if (job.status === "new") assert.equal(job.assigneeId, null);
    if (job.isEmergency) { assert.equal(job.clientWindowStart, "2026-08-17T00:00"); assert.equal(job.clientWindowEnd, "2026-08-18T00:00"); }
    if (job.workNames.some(name => name.startsWith("TVE/ENT"))) assert.equal(job.workTypeIds.length, 1);
  }
  assert.equal(manifest.workers.filter(worker => worker.name === "Бригада Каушнян").length, 2);
});

test("IMP-02 atomic full import, references, completed provenance, repeat does not reset edits", async () => {
  const f = await fixture();
  try {
    assert.equal((await importBeelineIntoEmptyDatabase(f.database, "ADMIN")).imported, true);
    assert.deepEqual(f.db.prepare("PRAGMA foreign_key_check").all(), []);
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM work_orders WHERE status='new' AND assignee_worker_id IS NULL").get().n, 203);
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM worker_work_competencies").get().n, 135);
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM work_order_work_types").get().n, 218);
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM memberships WHERE user_id='ADMIN'").get().n, 3);
    const imported = f.db.prepare("SELECT * FROM work_orders WHERE organization_id=? AND number=?").get(manifest.jobs[0].divisionId,manifest.jobs[0].number);
    assert.equal(Date.parse(imported.client_window_start), Date.parse(`${manifest.jobs[0].clientWindowStart}+03:00`));
    assert.ok(f.db.prepare('SELECT id FROM work_orders').all().every(row=>/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(row.id)));
    assert.equal(f.db.prepare("SELECT completed_at FROM work_orders WHERE status='completed'").get().completed_at, null);
    assert.equal(JSON.parse(f.db.prepare("SELECT manifest_json FROM dataset_imports").get().manifest_json).excludedJobs[0].source.controlRow, 50);
    const id = imported.id;
    f.db.prepare("UPDATE work_orders SET description='Dispatcher edit' WHERE id=?").run(id);
    assert.equal((await importBeelineIntoEmptyDatabase(f.database, "ADMIN")).imported, false);
    assert.equal(f.db.prepare("SELECT description FROM work_orders WHERE id=?").get(id).description, "Dispatcher edit");
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM work_orders").get().n, 204);
  } finally { f.db.close(); }
});

test("IMP-03 a nonempty target or mid-import failure leaves the database intact", async () => {
  const f = await fixture();
  try {
    f.db.exec("INSERT INTO organizations (id,name,created_at,updated_at) VALUES ('existing','Existing','now','now')");
    await assert.rejects(importBeelineIntoEmptyDatabase(f.database, "ADMIN"), /dataset_import_empty_target/);
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM organizations").get().n, 1);
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM dataset_imports").get().n, 0);
    f.db.exec("DELETE FROM organizations WHERE id='existing'");
    f.failAfter = 10;
    await assert.rejects(importBeelineIntoEmptyDatabase(f.database, "ADMIN"), /injected failure/);
    for (const table of ["organizations", "work_orders", "workers", "work_types", "dataset_imports", "application_dataset"]) assert.equal(f.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n, 0);
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM users").get().n, 1);
    f.failAfter = Infinity;
    assert.equal((await importBeelineIntoEmptyDatabase(f.database, "ADMIN")).imported, true);
  } finally { f.db.close(); }
});

test("IMP-05 imported composite visit reaches the mobile API with its real versions, service norm and dataset namespace", async () => {
  const f=await fixture();
  try {
    await importBeelineIntoEmptyDatabase(f.database,"ADMIN");
    const job=manifest.jobs.find(j=>j.workTypeIds.length>1);
    const worker=manifest.workers.find(w=>w.divisionId===job.divisionId && job.workTypeIds.every(id=>w.competencies.some(c=>c.categoryId===job.categoryId && c.workTypeId===id)));
    const row=f.db.prepare("SELECT id,organization_id FROM work_orders WHERE organization_id=? AND number=?").get(job.divisionId,job.number);
    f.db.prepare("UPDATE work_orders SET assignee_worker_id=?,status='assigned' WHERE id=?").run(worker.id,row.id);
    const state=await mobileState({database:f.database,user:{id:"ADMIN",email:"admin@example.invalid"},workerId:worker.id,organizationId:row.organization_id,workerName:worker.name,organizationName:"Подразделение",timezone:"Europe/Moscow",onShift:true},"2026-08-17");
    const visit=state.visits.find(v=>v.id===row.id);
    assert.equal(state.datasetVersion,manifest.datasetVersion);
    assert.deepEqual(visit.workTypes.map(w=>w.name),job.workNames);
    assert.equal(visit.durationMinutes,job.serviceDurationMinutes);
    assert.equal(visit.clientWindowStart,job.clientWindowStart);
    assert.equal(visit.clientWindowEnd,job.clientWindowEnd);
    assert.equal(visit.address,job.address);
    assert.equal(visit.equipment.length,0);
    assert.ok(state.profile.skills.some(s=>s.includes(" → ")));
  } finally { f.db.close(); }
});
