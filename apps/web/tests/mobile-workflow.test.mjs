import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import ts from "typescript";

// Load the real server functions without starting Cloudflare or touching local D1.
async function sourceModule(file, imports = {}) {
  let code = ts.transpileModule(await readFile(new URL(file, import.meta.url), "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
  for (const [name, url] of Object.entries(imports)) code = code.replaceAll(`from "${name}"`, `from "${url}"`);
  return `data:text/javascript;base64,${Buffer.from(code + `\n//# sourceURL=${file}\n`).toString("base64")}`;
}
const errorsUrl = await sourceModule("../app/lib/server/mobile/errors.ts");
const regionalUrl=await sourceModule("../../../packages/provider-contracts/src/regional-time.ts");
const schedulingUrl=await sourceModule("../app/lib/request-scheduling.ts",{"./regional-time":regionalUrl});
const reportUrl=await sourceModule("../app/lib/report-requirements.ts");
const stateUrl = await sourceModule("../app/lib/server/mobile/state.ts", {"./errors":errorsUrl, "../../regional-time":regionalUrl,"../../request-scheduling":schedulingUrl,"../../report-requirements":reportUrl});
const { executeCommand, allowedTransition } = await import(await sourceModule("../app/lib/server/mobile/commands.ts", {"./errors":errorsUrl,"./state":stateUrl,"../../report-requirements":reportUrl}));
const { mobileState } = await import(stateUrl);
const { appendPausedVisits } = await import(await sourceModule("../app/dispatcher/paused-visits.ts"));

function fixture() {
  const db = new DatabaseSync(":memory:");
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE users (id TEXT PRIMARY KEY, status TEXT);
    CREATE TABLE organizations (id TEXT PRIMARY KEY,timezone TEXT DEFAULT 'Europe/Moscow');
    CREATE TABLE application_dataset (id INTEGER PRIMARY KEY,version TEXT);
    CREATE TABLE workers (id TEXT PRIMARY KEY,user_id TEXT,organization_id TEXT,active INTEGER,shift_status TEXT,full_name TEXT,updated_at TEXT);
    CREATE TABLE memberships (user_id TEXT,organization_id TEXT,role_id TEXT,status TEXT);
    CREATE TABLE role_permissions (role_id TEXT,permission_code TEXT);
    CREATE TABLE work_orders (scheduling_timezone TEXT, service_duration_minutes INTEGER, category_id TEXT, client_window_start TEXT, client_window_end TEXT, id TEXT PRIMARY KEY,organization_id TEXT,assignee_worker_id TEXT,revision INTEGER DEFAULT 0,
      status TEXT CHECK(status IN ('new','assigned','en_route','in_progress','paused','completed','confirmed','cancelled')),
      completed_at TEXT,updated_at TEXT,number TEXT,work_type_version_id TEXT DEFAULT 'V',address_snapshot TEXT DEFAULT 'Москва',service_object_id TEXT,
      apartment TEXT DEFAULT '', entrance TEXT DEFAULT '', intercom TEXT DEFAULT '', scheduled_start TEXT DEFAULT '2026-09-08T09:00',scheduled_end TEXT,priority TEXT DEFAULT 'medium',description TEXT DEFAULT '',latitude_snapshot REAL,longitude_snapshot REAL);
    CREATE TRIGGER work_orders_increment_revision AFTER UPDATE ON work_orders WHEN NEW.revision=OLD.revision
      BEGIN UPDATE work_orders SET revision=OLD.revision+1 WHERE id=NEW.id; END;
    CREATE TABLE mobile_commands (user_id TEXT,operation_id TEXT,fingerprint TEXT,accepted INTEGER,created_at TEXT,
      PRIMARY KEY(user_id,operation_id),CONSTRAINT mobile_command_precondition CHECK(accepted=1));
    CREATE TABLE mobile_issues (id TEXT PRIMARY KEY,work_order_id TEXT,worker_id TEXT,reason TEXT,detail TEXT,created_at TEXT);
    CREATE TABLE work_order_status_history (id TEXT PRIMARY KEY,work_order_id TEXT,from_status TEXT,to_status TEXT,changed_by_user_id TEXT,reason TEXT,created_at TEXT);
    CREATE TABLE audit_events (id TEXT PRIMARY KEY,organization_id TEXT,actor_user_id TEXT,entity_type TEXT,entity_id TEXT,action TEXT,payload_json TEXT,created_at TEXT);
    CREATE TABLE mobile_notice_reads (user_id TEXT,event_id TEXT,read_at TEXT,PRIMARY KEY(user_id,event_id));
    CREATE TABLE work_order_work_types (work_order_id TEXT, work_type_version_id TEXT, sequence INTEGER, name_snapshot TEXT);
    CREATE TABLE work_types (id TEXT PRIMARY KEY,name TEXT);
    CREATE TABLE work_categories (id TEXT PRIMARY KEY,name TEXT);
    CREATE TABLE worker_work_competencies (worker_id TEXT,category_id TEXT,work_type_id TEXT);
    CREATE TABLE work_order_equipment (work_order_id TEXT,equipment_id TEXT,name_snapshot TEXT,unit_snapshot TEXT,usage_snapshot TEXT,quantity REAL);
    CREATE TABLE work_type_versions (id TEXT PRIMARY KEY,work_type_id TEXT,planned_duration_minutes INTEGER,is_emergency INTEGER DEFAULT 0,report_template_json TEXT DEFAULT '{}',evidence_policy_json TEXT DEFAULT '{}',auto_accept_report INTEGER DEFAULT 0,verification_mode TEXT DEFAULT 'dispatcher',ai_verifier_connection_id TEXT);
    CREATE TABLE service_objects (id TEXT PRIMARY KEY,notes TEXT);
    CREATE TABLE work_reports (id TEXT PRIMARY KEY,work_order_id TEXT,performer_worker_id TEXT,revision INTEGER,status TEXT,comment TEXT,field_values_json TEXT DEFAULT '{}',submitted_at TEXT,updated_at TEXT);
    CREATE TABLE report_media (id TEXT PRIMARY KEY,report_id TEXT,kind TEXT,file_name TEXT,mime_type TEXT,size_bytes INTEGER,captured_at TEXT,created_at TEXT,upload_status TEXT,storage_key TEXT);
    CREATE TABLE worker_skills (worker_id TEXT,skill_id TEXT);
    CREATE TABLE skills (id TEXT PRIMARY KEY,name TEXT);
    INSERT INTO organizations(id) VALUES ('ORG'),('OTHER');
    INSERT INTO users VALUES ('USER','active'),('OTHER-USER','active');
    INSERT INTO workers VALUES ('WORKER','USER','ORG',1,'on_shift','Инженер',NULL),('OTHER-WORKER','OTHER-USER','OTHER',1,'on_shift','Другой',NULL);
    INSERT INTO memberships VALUES ('USER','ORG','executor','active');
    INSERT INTO role_permissions VALUES ('executor','mobile.execute');
    INSERT INTO work_types VALUES ('T','Диагностика');
    INSERT INTO work_type_versions(id,work_type_id,planned_duration_minutes) VALUES ('V','T',60);
    INSERT INTO work_orders (id,number,organization_id,assignee_worker_id,status) VALUES
      ('FIRST','FIRST','ORG','WORKER','assigned'),('SECOND','SECOND','ORG','WORKER','assigned'),('FOREIGN','FOREIGN','OTHER','OTHER-WORKER','assigned');`);
  const database = {
    prepare(sql) {
      const statement = { values: [], bind(...values) { this.values = values; return this; },
        async first() { return db.prepare(sql).get(...this.values) ?? null; },
        async all() { return { results: db.prepare(sql).all(...this.values) }; },
        async run() { return db.prepare(sql).run(...this.values); } };
      return statement;
    },
    async batch(statements) {
      db.exec("BEGIN IMMEDIATE");
      try { const results = []; for (const statement of statements) results.push(await statement.run()); db.exec("COMMIT"); return results; }
      catch (error) { db.exec("ROLLBACK"); throw error; }
    },
  };
  const ctx = { database, user:{id:"USER"}, workerId:"WORKER", organizationId:"ORG", timezone:"Europe/Moscow", onShift:true };
  const order = id => db.prepare("SELECT * FROM work_orders WHERE id=?").get(id);
  const command = (id, status) => ({operationId:randomUUID(),action:"status",visitId:id,revision:order(id).revision,status});
  const problem = (id, overrides = {}) => ({operationId:randomUUID(),action:"problem",visitId:id,revision:order(id).revision,reason:"Нет доступа",details:"Дверь закрыта, ожидаю ответственного",...overrides});
  return {db,ctx,order,command,problem,send:body=>executeCommand(ctx,body)};
}
const rejects = (promise, status) => assert.rejects(promise, error => error.status === status);

test("a dataset replacement rejects old status, shift, read and accepted replay commands without changing the new data", async t => {
  const f=fixture(); t.after(()=>f.db.close());
  const old = { operationId:randomUUID(), action:"shift", onShift:true };
  await f.send(old);
  f.db.exec("INSERT INTO application_dataset VALUES (1,'beeline-app-v1')");
  for (const command of [old, f.command("FIRST","in_progress"), {operationId:randomUUID(),action:"shift",onShift:false}, {operationId:randomUUID(),action:"read",ids:[]}]) {
    await assert.rejects(f.send(command), e=>e.status===409 && e.code==="dataset_changed");
  }
  assert.equal(f.order("FIRST").status,"assigned");
  assert.equal(f.db.prepare("SELECT shift_status FROM workers WHERE id='WORKER'").get().shift_status,"on_shift");
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM mobile_commands").get().n,1);
  assert.equal((await mobileState(f.ctx,"2026-09-08")).datasetVersion,"beeline-app-v1");
  await f.send({...f.command("FIRST","in_progress"),datasetVersion:"beeline-app-v1"});
  assert.equal(f.order("FIRST").status,"in_progress");
});

test("dataset version is rechecked atomically with command writes", async t => {
  const f=fixture(); t.after(()=>f.db.close());
  const batch=f.ctx.database.batch;
  f.ctx.database.batch=async statements=>{ f.db.exec("INSERT INTO application_dataset VALUES (1,'beeline-app-v1')"); return batch(statements); };
  await assert.rejects(f.send({operationId:randomUUID(),action:"shift",onShift:false,datasetVersion:"legacy"}),e=>e.status===409 && e.code==="dataset_changed");
  assert.equal(f.db.prepare("SELECT shift_status FROM workers WHERE id='WORKER'").get().shift_status,"on_shift");
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM mobile_commands").get().n,0);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM audit_events").get().n,0);
});

test("mobile calendar and schedule use the worker region across midnight, preserving stored appointments", async t => {
  const f = fixture(); t.after(() => f.db.close());
  f.ctx.timezone = "Asia/Yekaterinburg";
  f.db.exec("UPDATE work_orders SET scheduling_timezone='Europe/Moscow', scheduled_start='2026-09-08T23:30', scheduled_end='2026-09-09T00:30' WHERE id='FIRST'");
  const selected = await mobileState(f.ctx, "2026-09-09");
  const visit = selected.visits.find(item => item.id === "FIRST");
  assert.equal(visit.scheduledStart, "2026-09-09T01:30");
  assert.equal(visit.scheduledEnd, "2026-09-09T02:30");
  assert.ok(selected.availableDates.includes("2026-09-09"));
  assert.equal(selected.profile.timezone, "Asia/Yekaterinburg");
  assert.ok(!(await mobileState(f.ctx, "2026-09-08")).visits.some(item => item.id === "FIRST"));
  assert.equal(f.order("FIRST").scheduled_start, "2026-09-08T23:30");
  await rejects(mobileState(f.ctx, "2026-02-30"), 400);
});

test("mobile composition keeps all HD, independent client windows, equipment snapshots and concise changes within the assigned department", async t => {
  const f = fixture(); t.after(() => f.db.close()); f.ctx.timezone = "Asia/Yekaterinburg";
  f.db.exec(`INSERT INTO work_categories VALUES ('BK','Подключение');
    INSERT INTO work_types VALUES ('T2','Роутер');
    INSERT INTO worker_work_competencies VALUES ('WORKER','BK','T'),('WORKER','BK','T2');
    INSERT INTO work_order_work_types VALUES ('FIRST','V',0,'Диагностика'),('FIRST','V2',1,'Роутер'),('FOREIGN','VF',0,'Чужой HD');
    INSERT INTO work_order_equipment VALUES ('FIRST','E1','Кабель на момент назначения','м','consumable',20),('FIRST','E2','Тестер','шт.','reusable',NULL),('FOREIGN','EF','Чужое оборудование','шт.','consumable',9);
    UPDATE work_orders SET category_id='BK',scheduling_timezone='Europe/Moscow',client_window_start='2026-09-08T20:00:00Z',client_window_end='2026-09-08T21:00:00Z',scheduled_start='2026-09-08T23:30',scheduled_end='2026-09-09T00:30' WHERE id='FIRST';`);
  const payload = { source: "planning", reason: "Прежний исполнитель недоступен.", before: {workerName:"Бригада 1",start:"2026-09-08T23:00",timezone:"Europe/Moscow"}, after:{workerName:"Бригада 2",start:"2026-09-08T23:30",timezone:"Europe/Moscow"} };
  f.db.prepare("INSERT INTO audit_events VALUES ('A','ORG','USER','work_order','FIRST','scheduling_changed',?,'2026-09-08T10:00:00Z')").run(JSON.stringify(payload));
  f.db.prepare("INSERT INTO audit_events VALUES ('AF','OTHER','OTHER-USER','work_order','FOREIGN','scheduling_changed',?,'2026-09-08T10:00:00Z')").run(JSON.stringify({...payload,reason:"Чужая история"}));
  const state = await mobileState(f.ctx,"2026-09-09"); const visit = state.visits.find(v => v.id === "FIRST");
  assert.equal(visit.categoryName,"Подключение");
  assert.deepEqual(visit.workTypes.map(t => t.name),["Диагностика","Роутер"]);
  assert.equal(visit.clientWindowStart,"2026-09-09T01:00"); assert.equal(visit.clientWindowEnd,"2026-09-09T02:00");
  assert.equal(visit.scheduledStart,"2026-09-09T01:30"); assert.equal(visit.scheduledEnd,"2026-09-09T02:30");
  assert.equal(visit.equipment.length,2); assert.equal(visit.equipment[0].quantity,20); assert.equal(visit.equipment[1].quantity,null);
  assert.equal(visit.equipment[0].name,"Кабель на момент назначения");
  assert.deepEqual(state.profile.skills,["Подключение → Диагностика","Подключение → Роутер"]);
  assert.match(visit.events[0].detail,/Прежний исполнитель недоступен.*Бригада 1.*01:00.*→.*Бригада 2.*01:30/u);
  assert.doesNotMatch(JSON.stringify(state),/Чуж/);
  assert.equal(state.notices.length,0,"scheduling audit IDs must not enter status-history read acknowledgements");
});

test("problem atomically pauses and timestamps a visit; retry is idempotent", async t => {
  const f=fixture();t.after(()=>f.db.close());
  await f.send(f.command("FIRST","in_progress"));
  const previous = f.order("FIRST"); const body=f.problem("FIRST");
  await f.send(body);
  assert.equal(f.order("FIRST").status,"paused");
  assert.equal(f.order("FIRST").revision,previous.revision+1);
  assert.equal(f.order("FIRST").completed_at,null);
  const issue=f.db.prepare("SELECT * FROM mobile_issues").get();
  const history=f.db.prepare("SELECT * FROM work_order_status_history WHERE to_status='paused'").get();
  assert.equal(issue.created_at,history.created_at);
  assert.equal(issue.created_at,f.order("FIRST").updated_at);
  assert.ok(Number.isFinite(Date.parse(issue.created_at)));
  assert.equal((await f.send(body)).replayed,true);
  await rejects(f.send({...body,details:"Другое описание проблемы"}),409);
  await rejects(f.send(f.problem("FIRST")),409);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM mobile_issues").get().n,1);
});

test("another visit may start while paused; resume obeys active-work and shift rules", async t => {
  const f=fixture();t.after(()=>f.db.close());
  await f.send(f.problem("FIRST"));
  await f.send(f.command("SECOND","in_progress"));
  await rejects(f.send(f.command("FIRST","in_progress")),409);
  await f.send(f.problem("SECOND"));
  await f.send({operationId:randomUUID(),action:"shift",onShift:false});
  await rejects(f.send(f.command("FIRST","in_progress")),409);
  await f.send({operationId:randomUUID(),action:"shift",onShift:true});
  await f.send(f.command("FIRST","in_progress"));
  assert.equal(f.order("FIRST").status,"in_progress");
  assert.equal(f.order("SECOND").status,"paused");
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM work_orders WHERE assignee_worker_id='WORKER' AND status IN ('en_route','in_progress')").get().n,1);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM mobile_issues").get().n,2);
  const history=f.db.prepare("SELECT * FROM work_order_status_history WHERE from_status='paused'").get();
  assert.equal(history.to_status,"in_progress");
});

test("stale, foreign, invalid, and closed problem commands leave no partial writes", async t => {
  const f=fixture();t.after(()=>f.db.close());
  await rejects(f.send(f.problem("FOREIGN")),404);
  await rejects(f.send(f.problem("FIRST",{details:"   "})),400);
  const stale=f.problem("FIRST");await f.send(f.command("FIRST","in_progress"));
  await rejects(f.send(stale),409);
  assert.equal(f.order("FIRST").status,"in_progress");
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM mobile_issues").get().n,0);
  f.db.prepare("UPDATE work_orders SET status='completed' WHERE id='FIRST'").run();
  await rejects(f.send(f.problem("FIRST")),409);
});

test("revision conflict can be explicitly retried without losing or duplicating the problem", async t => {
  const f=fixture();t.after(()=>f.db.close());
  const stale=f.problem("FIRST");
  f.db.prepare("UPDATE work_orders SET updated_at='metadata-only' WHERE id='FIRST'").run();
  await assert.rejects(f.send(stale), e=>e.status===409 && e.code==="revision_conflict");
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM mobile_commands").get().n,0);
  const revised={...stale,operationId:randomUUID(),revision:f.order("FIRST").revision};
  await f.send(revised);
  assert.equal(f.order("FIRST").status,"paused");
  assert.equal((await f.send(revised)).replayed,true);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM mobile_issues").get().n,1);
  assert.equal(f.db.prepare("SELECT detail FROM mobile_issues").get().detail,stale.details);
  await assert.rejects(f.send({...revised,revision:f.order("FIRST").revision}), e=>e.status===409 && e.code!=="revision_conflict");
});

test("replay of an accepted command succeeds even after the order revision changes again", async t => {
  const f=fixture();t.after(()=>f.db.close());const problem=f.problem("FIRST");
  await f.send(problem);await f.send(f.command("FIRST","in_progress"));
  assert.equal((await f.send(problem)).replayed,true);
  assert.equal(f.order("FIRST").status,"in_progress");
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM mobile_issues").get().n,1);
});

test("a concurrent edit inside the write guard remains a revision conflict with no partial issue", async t => {
  const f=fixture();t.after(()=>f.db.close());const body=f.problem("FIRST");
  const batch=f.ctx.database.batch;
  f.ctx.database.batch=async statements=>{
    f.db.prepare("UPDATE work_orders SET address_snapshot='Новый адрес' WHERE id='FIRST'").run();
    return batch(statements);
  };
  await assert.rejects(f.send(body),e=>e.status===409 && e.code==="revision_conflict");
  assert.equal(f.order("FIRST").status,"assigned");
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM mobile_issues").get().n,0);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM mobile_commands").get().n,0);
});

test("repeated pause/resume cycles retain every issue and cannot skip completion report", async t => {
  const f=fixture();t.after(()=>f.db.close());
  await f.send(f.problem("FIRST"));
  await rejects(f.send(f.command("FIRST","completed")),409);
  await f.send(f.command("FIRST","in_progress"));
  await rejects(f.send(f.command("FIRST","completed")),400);
  await f.send(f.problem("FIRST",{reason:"Нет материалов",details:"Необходим новый кабель"}));
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM mobile_issues WHERE work_order_id='FIRST'").get().n,2);
  assert.equal(allowedTransition("paused","assigned"),false);
  assert.equal(allowedTransition("paused","in_progress"),true);
});

test("paused visits from previous days remain available and journal keeps timestamps", async t => {
  const f=fixture();t.after(()=>f.db.close());
  f.db.prepare("UPDATE work_orders SET scheduled_start='2026-09-07T09:00' WHERE id='FIRST'").run();
  await f.send(f.problem("FIRST"));
  const state=await mobileState(f.ctx,"2026-09-08");
  assert.deepEqual(state.visits.map(v=>v.id),["SECOND","FIRST"]);
  const paused=state.visits[1];assert.equal(paused.status,"paused");
  assert.equal(paused.problemLog.length,1);assert.ok(paused.problemLog[0].createdAt);
  assert.match(paused.problems[0],/\d{2}\.\d{2}.*Нет доступа/u);
});

test("dispatcher puts paused work last and preserves workers without optimized routes", () => {
  const worker={id:"W",name:"Инженер",vehicle:"Автомобиль",load:0};
  const card={...worker,initials:"И",accent:"gold",visits:[{requestId:"PAUSED",time:"09:00",label:"Пауза"},{requestId:"NEXT",time:"10:00",label:"Следующая"}]};
  const request={id:"PAUSED",status:"paused",dateTime:"2026-09-07T09:00",assignee:"Инженер",assigneeId:"W"};
  const cards=appendPausedVisits([card],[request],[worker]);
  assert.deepEqual(cards[0].visits.map(v=>v.requestId),["NEXT","PAUSED"]);
  assert.equal(cards[0].visits[1].paused,true);
  assert.equal(appendPausedVisits([],[request],[worker])[0].id,"W");
  assert.equal(card.visits[0].paused,undefined);
});
