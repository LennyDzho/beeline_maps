import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

const moduleUrl = (code) => `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;
async function sourceModule(file, imports = {}) {
  let code = ts.transpileModule(await readFile(new URL(file, import.meta.url), "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  for (const [name, url] of Object.entries(imports)) code = code.replaceAll(`from "${name}"`, `from "${url}"`);
  return moduleUrl(code + `\n//# sourceURL=${file}\n`);
}
const catalogueUrl = await sourceModule("../app/lib/server/qualifications.ts");
const catalogue = await import(catalogueUrl);
const skillsUrl = await sourceModule("../app/lib/server/skills.ts");
const skillsCatalogue = await import(skillsUrl);
const workCatalogUrl = await sourceModule("../app/lib/work-catalog.ts");
const serverWorkCatalogUrl = await sourceModule("../app/lib/server/work-catalog.ts", { "../work-catalog": workCatalogUrl });
const catalogMigration = await readFile(new URL("../drizzle/0013_work_catalog_components.sql", import.meta.url), "utf8");
const importMigration = await readFile(new URL("../drizzle/0015_dataset_import_state.sql", import.meta.url), "utf8");
const reportUrl=await sourceModule("../app/lib/report-requirements.ts");
const dataUrl = await sourceModule("../app/api/admin/_data.ts", { "@/app/lib/server/work-catalog": serverWorkCatalogUrl, "@/app/lib/report-requirements":reportUrl });
const { listWorkTypes } = await import(dataUrl);
const idsUrl = await sourceModule("../app/admin/qualification-data.ts");
const { isQualificationIds } = await import(idsUrl);
const nextUrl = moduleUrl(`export class NextResponse extends Response {
  static json(body, init) { return new NextResponse(JSON.stringify(body), { ...init, headers: { 'content-type': 'application/json' } }); }
}`);
const fixtureKey = "mmi.test.qualifications";
const sharedUrl = await sourceModule("../app/api/_shared.ts", {
  "next/server": nextUrl,
  "@/auth/session": moduleUrl(`export async function getCurrentUser() { return globalThis[Symbol.for('${fixtureKey}')].user; }`),
  "@/db/domain-storage": moduleUrl(`export async function ensureDomainData() { return globalThis[Symbol.for('${fixtureKey}')].database; }`),
  "@/auth/organization-context": moduleUrl(`export async function resolveUserOrganizationContext() { return { currentOrganization: { id: globalThis[Symbol.for('${fixtureKey}')].organizationId } }; }`),
});
const vehicleUrl = await sourceModule("../app/lib/server/worker-vehicles.ts", { "./work-catalog": serverWorkCatalogUrl });
const categoryEquipmentMigration = await readFile(new URL("../drizzle/0026_category_equipment_and_employee_numbers.sql",import.meta.url),"utf8");
const routeImports = {
  "@/app/lib/server/worker-vehicles":vehicleUrl,
  "@/app/lib/report-requirements":reportUrl,
  "@/app/lib/work-catalog": workCatalogUrl, "@/app/lib/server/work-catalog": serverWorkCatalogUrl,
  "@/app/lib/regional-time": await sourceModule("../../../packages/provider-contracts/src/regional-time.ts"),
  "next/server": nextUrl, "@/app/api/_shared": sharedUrl,
  "@/app/lib/server/qualifications": catalogueUrl,
  "@/app/lib/server/skills": skillsUrl,
  "@/app/admin/skill-data": await sourceModule("../app/admin/skill-data.ts"),
  "@/app/admin/qualification-data": idsUrl, "@/app/api/admin/_data": dataUrl,
  "@/app/lib/planned-duration": await sourceModule("../app/lib/planned-duration.ts"),
};
const qualificationRoute = await import(await sourceModule("../app/api/admin/qualifications/route.ts", routeImports));
const workTypeRoute = await import(await sourceModule("../app/api/admin/work-types/route.ts", routeImports));
const engineerRoute = await import(await sourceModule("../app/api/engineers/route.ts", routeImports));
const skillsRoute = await import(await sourceModule("../app/api/admin/skills/route.ts", routeImports));

// All changes are made in this isolated SQLite database; never use local D1.
function fixture(t) {
  const db = new DatabaseSync(":memory:");
  t.after(() => { db.close(); delete globalThis[Symbol.for(fixtureKey)]; });
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE organizations (id TEXT PRIMARY KEY, timezone TEXT DEFAULT 'Europe/Moscow');
    CREATE TABLE qualifications (id TEXT PRIMARY KEY, organization_id TEXT REFERENCES organizations(id), code TEXT, name TEXT, description TEXT DEFAULT '', validity_required INTEGER DEFAULT 0, active INTEGER DEFAULT 1, UNIQUE(organization_id,code));
    CREATE TABLE workers (id TEXT PRIMARY KEY, timezone TEXT, organization_id TEXT REFERENCES organizations(id), user_id TEXT, service_area_id TEXT, work_schedule_id TEXT, employee_number TEXT, full_name TEXT, phone TEXT, shift_status TEXT DEFAULT 'on_shift', load_percent INTEGER DEFAULT 0, transport_mode TEXT DEFAULT 'none', transport_details TEXT DEFAULT 'Нет', qualification_warning INTEGER DEFAULT 0, active INTEGER DEFAULT 1, start_address TEXT DEFAULT 'Москва', start_latitude REAL DEFAULT 55.7, start_longitude REAL DEFAULT 37.6, created_at TEXT, updated_at TEXT);
    CREATE TABLE worker_qualifications (worker_id TEXT REFERENCES workers(id), qualification_id TEXT REFERENCES qualifications(id), document_number TEXT DEFAULT '', issued_at TEXT, expires_at TEXT, status TEXT DEFAULT 'valid', PRIMARY KEY(worker_id,qualification_id));
    CREATE TABLE work_types (id TEXT PRIMARY KEY, organization_id TEXT REFERENCES organizations(id), code TEXT, name TEXT, description TEXT DEFAULT '', active INTEGER DEFAULT 1, created_at TEXT, updated_at TEXT);
    CREATE TABLE work_type_versions (id TEXT PRIMARY KEY, work_type_id TEXT REFERENCES work_types(id), version INTEGER, status TEXT DEFAULT 'published', planned_duration_minutes INTEGER DEFAULT 60, is_emergency INTEGER DEFAULT 0, auto_accept_report INTEGER DEFAULT 0,verification_mode TEXT DEFAULT 'dispatcher', ai_verifier_connection_id TEXT, report_template_json TEXT, evidence_policy_json TEXT, published_by_user_id TEXT, published_at TEXT, created_at TEXT);
    CREATE TABLE work_type_version_qualifications (work_type_version_id TEXT REFERENCES work_type_versions(id), qualification_id TEXT REFERENCES qualifications(id), PRIMARY KEY(work_type_version_id,qualification_id));
    CREATE TABLE skills (id TEXT PRIMARY KEY, organization_id TEXT REFERENCES organizations(id), name TEXT, description TEXT DEFAULT '', active INTEGER DEFAULT 1, UNIQUE(organization_id,name));
    CREATE TABLE worker_skills (worker_id TEXT REFERENCES workers(id), skill_id TEXT REFERENCES skills(id), level TEXT DEFAULT 'qualified', confirmed_at TEXT, PRIMARY KEY(worker_id,skill_id));
    CREATE TABLE work_type_version_skills (work_type_version_id TEXT REFERENCES work_type_versions(id), skill_id TEXT REFERENCES skills(id), PRIMARY KEY(work_type_version_id,skill_id));
    CREATE TABLE service_areas (id TEXT PRIMARY KEY, organization_id TEXT, name TEXT, active INTEGER DEFAULT 1);
    CREATE TABLE work_schedules (id TEXT PRIMARY KEY, organization_id TEXT, name TEXT, active INTEGER DEFAULT 1);
    CREATE TABLE work_schedule_days (schedule_id TEXT, weekday INTEGER, enabled INTEGER, start_time TEXT, end_time TEXT, break_start TEXT, break_end TEXT);
    CREATE TABLE users (id TEXT PRIMARY KEY, display_name TEXT, email TEXT);
    CREATE TABLE memberships (user_id TEXT, organization_id TEXT, role_id TEXT, status TEXT);
    CREATE TABLE roles (id TEXT PRIMARY KEY, code TEXT);
    CREATE TABLE role_permissions (role_id TEXT, permission_code TEXT);
    INSERT INTO organizations(id) VALUES ('ORG'), ('OTHER');
    INSERT INTO users VALUES ('USER','Тест','test@example.invalid');
    INSERT INTO memberships VALUES ('USER','ORG','ADMIN','active');
    INSERT INTO roles VALUES ('ADMIN','executor');
    INSERT INTO role_permissions VALUES ('ADMIN','admin.settings'), ('ADMIN','engineers.manage');
    INSERT INTO qualifications (id,organization_id,code,name,validity_required) VALUES
      ('Q1','ORG','CODE-1','Допуск 1',1), ('Q2','ORG','CODE-2','Мастер',0),
      ('Q3','ORG','CODE-3','Свободный',0), ('Q4','ORG','CODE-4','Архивный',0), ('QF','OTHER','CODE-1','Чужой',0);
    INSERT INTO skills (id,organization_id,name) VALUES ('S1','ORG','Электрика');
    INSERT INTO service_areas (id,organization_id,name) VALUES ('A1','ORG','Север');
    INSERT INTO work_schedules (id,organization_id,name) VALUES ('SC1','ORG','График');
    INSERT INTO workers (id,organization_id,user_id,service_area_id,work_schedule_id,employee_number,full_name,phone) VALUES ('EMP-1','ORG','USER','A1','SC1','EMP-1','Тестовый исполнитель','123');
    INSERT INTO worker_skills VALUES ('EMP-1','S1','qualified',NULL);
    INSERT INTO worker_qualifications VALUES ('EMP-1','Q1','DOC-1','2026-01-01','2027-01-01','expiring'), ('EMP-1','Q2','DOC-2',NULL,NULL,'suspended');
    INSERT INTO work_types (id,organization_id,code,name) VALUES ('WORK-001','ORG','T1','Работа'), ('WORK-002','OTHER','T2','Чужая работа');
    INSERT INTO work_type_versions (id,work_type_id,version,status) VALUES ('V0','WORK-001',1,'archived'), ('V1','WORK-001',2,'published'), ('VF','WORK-002',1,'published');
    INSERT INTO work_type_version_qualifications VALUES ('V0','Q1'), ('V0','Q4'), ('V1','Q1'), ('VF','QF');
    INSERT INTO work_type_version_skills VALUES ('V1','S1');`);
  db.exec("CREATE TABLE work_orders (id TEXT PRIMARY KEY, work_type_version_id TEXT REFERENCES work_type_versions(id))");
  db.exec("ALTER TABLE workers ADD COLUMN travel_mode TEXT");
  db.exec(catalogMigration);
  db.exec(importMigration);
  db.exec("CREATE TABLE resources (id TEXT PRIMARY KEY,organization_id TEXT,name TEXT,plate TEXT,assigned_worker_id TEXT,status TEXT,condition TEXT,type TEXT,updated_at TEXT)");
  db.exec(categoryEquipmentMigration);
  const database = {
    prepare(sql) {
      return {
        values: [], bind(...values) { this.values = values; return this; },
        async first() { return db.prepare(sql).get(...this.values) ?? null; },
        async all() { return { results: db.prepare(sql).all(...this.values) }; },
        async run() { const result = db.prepare(sql).run(...this.values); return { success: true, meta: { changes: Number(result.changes) } }; },
      };
    },
    async batch(statements) {
      db.exec("BEGIN");
      try { const results = []; for (const statement of statements) results.push(await statement.run()); db.exec("COMMIT"); return results; }
      catch (error) { db.exec("ROLLBACK"); throw error; }
    },
  };
  const context = { database, organizationId: "ORG", user: { id: "USER" } };
  globalThis[Symbol.for(fixtureKey)] = context;
  const request = (method = "GET", body, headers = {}) => new Request("http://localhost/api/admin/qualifications", { method, headers: { origin: "http://localhost", "content-type": "application/json", ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  return { db, database, context, request, links: () => db.prepare("SELECT * FROM worker_qualifications ORDER BY qualification_id").all() };
}
const input = (name, active = true) => ({ name, description: "Описание", active });

test("catalogue create/read is persistent and shared across divisions", async (t) => {
  const f = fixture(t);
  const result = await qualificationRoute.POST(f.request("POST", { ...input(" Новый   допуск "), organizationId: "OTHER" }));
  assert.equal(result.status, 201);
  const { item } = await result.json();
  assert.equal(item.name, "Новый допуск");
  assert.ok(item.id.startsWith("QUAL-"));
  const rows = (await (await qualificationRoute.GET(f.request())).json()).items;
  assert.ok(rows.some((row) => row.id === item.id));
  assert.ok(rows.some((row) => row.id === "QF"));
  assert.deepEqual(await catalogue.listQualifications(f.database, "OTHER"), rows);
});

test("rename preserves IDs, code, validity policy, worker documents and type versions", async (t) => {
  const f = fixture(t);
  const links = f.links();
  const versions = f.db.prepare("SELECT * FROM work_type_version_qualifications").all();
  const result = await qualificationRoute.PUT(f.request("PUT", { id: "Q1", ...input("Электробезопасность IV") }));
  assert.equal(result.status, 200);
  const { item } = await result.json();
  assert.equal(item.code, "CODE-1");
  assert.equal(item.workerCount, 1);
  assert.equal(item.workTypeCount, 1); // two versions of the same type count once
  assert.equal(f.db.prepare("SELECT validity_required FROM qualifications WHERE id='Q1'").get().validity_required, 1);
  assert.deepEqual(f.links(), links);
  assert.deepEqual(f.db.prepare("SELECT * FROM work_type_version_qualifications").all(), versions);
  const types = await listWorkTypes(f.database, "ORG");
  assert.deepEqual(types[0].requiredQualificationIds, ["Q1"]);
  assert.deepEqual(types[0].requiredQualifications, ["Электробезопасность IV"]);
});

test("duplicates, invalid fields and nonexistent IDs cannot mutate the catalogue", async (t) => {
  const f = fixture(t);
  for (const body of [input("   "), input("x".repeat(201)), { ...input("Допуск"), active: "true" }, { ...input("Допуск"), description: "x".repeat(2001) }]) {
    assert.equal((await qualificationRoute.POST(f.request("POST", body))).status, 400);
  }
  assert.equal((await qualificationRoute.POST(f.request("POST", input("  дОпУсК   1  ")))).status, 409);
  assert.equal((await qualificationRoute.PUT(f.request("PUT", { id: "Q2", ...input("ДОПУСК 1") }))).status, 409);
  assert.equal((await qualificationRoute.PUT(f.request("PUT", { id: "MISSING", ...input("Взлом") }))).status, 404);
  // A shared label cannot be duplicated by changing division.
  await assert.rejects(catalogue.saveQualification(f.database, "OTHER", input("Допуск 1")), /уже существу/);
  assert.equal(f.db.prepare("SELECT name FROM qualifications WHERE id='QF'").get().name, "Чужой");
  assert.equal((await catalogue.listQualifications(f.database, "ORG")).length, 5);
});

test("used or historical-only qualifications cannot be disabled; unused ones can be reactivated", async (t) => {
  const f = fixture(t);
  for (const id of ["Q1", "Q2", "Q4"]) {
    const current = (await catalogue.listQualifications(f.database, "ORG")).find((item) => item.id === id);
    assert.equal((await qualificationRoute.PUT(f.request("PUT", { ...current, active: false }))).status, 409);
    assert.equal(f.db.prepare("SELECT active FROM qualifications WHERE id=?").get(id).active, 1);
  }
  await catalogue.saveQualification(f.database, "ORG", input("Свободный", false), "Q3");
  assert.equal(await catalogue.resolveQualificationIds(f.database, "ORG", { ids: ["Q3"], names: [] }), null);
  assert.deepEqual(await catalogue.resolveQualificationIds(f.database, "ORG", { ids: ["Q3"], names: [] }, ["Q3"]), ["Q3"]);
  await catalogue.saveQualification(f.database, "ORG", input("Свободный", true), "Q3");
  assert.deepEqual(await catalogue.resolveQualificationIds(f.database, "ORG", { names: ["Свободный"] }), ["Q3"]);
});

test("deactivation checks usage again inside the SQL write when an assignment arrives concurrently", async (t) => {
  const f = fixture(t);
  const prepare = f.database.prepare;
  f.database.prepare = (sql) => {
    const statement = prepare(sql);
    if (sql.startsWith("UPDATE qualifications SET")) {
      const run = statement.run.bind(statement);
      statement.run = async () => {
        f.db.exec("INSERT INTO worker_qualifications (worker_id,qualification_id) VALUES ('EMP-1','Q3')");
        return run();
      };
    }
    return statement;
  };
  await assert.rejects(catalogue.saveQualification(f.database, "ORG", input("Нельзя отключить", false), "Q3"), error => error.status === 409);
  const row = f.db.prepare("SELECT name,active FROM qualifications WHERE id='Q3'").get();
  assert.equal(row.active, 1);
  assert.equal(row.name, "Свободный");
});

test("catalogue API enforces authentication, permissions and same-origin protection", async (t) => {
  const f = fixture(t);
  const initial = (await catalogue.listQualifications(f.database, "ORG")).length;
  f.context.user = null;
  for (const method of ["GET", "POST", "PUT"]) assert.equal((await qualificationRoute[method](f.request(method, method === "GET" ? undefined : { id: "Q3", ...input("Новый") }))).status, 401);
  f.context.user = { id: "USER" };
  assert.equal((await qualificationRoute.POST(f.request("POST", input("Новый"), { origin: "https://foreign.invalid" }))).status, 403);
  f.db.exec("DELETE FROM role_permissions WHERE permission_code='admin.settings'");
  for (const method of ["GET", "POST", "PUT"]) assert.equal((await qualificationRoute[method](f.request(method, method === "GET" ? undefined : { id: "Q3", ...input("Новый") }))).status, 403);
  assert.equal((await catalogue.listQualifications(f.database, "ORG")).length, initial);
});

test("type edits use stable IDs after rename and reject missing, duplicate or inactive selections", async (t) => {
  const f = fixture(t);
  const type = (await listWorkTypes(f.database, "ORG"))[0];
  await catalogue.saveQualification(f.database, "ORG", input("Новое название"), "Q1");
  const response = await workTypeRoute.PUT(f.request("PUT", type)); // old label, same ID
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).item.requiredQualifications, ["Новое название"]);
  const count = f.db.prepare("SELECT COUNT(*) n FROM work_type_versions").get().n;
  for (const ids of [["MISSING"], ["Q1", "Q1"], [], [123]]) {
    assert.equal((await workTypeRoute.PUT(f.request("PUT", { ...type, requiredQualificationIds: ids }))).status, 400);
  }
  await catalogue.saveQualification(f.database, "ORG", input("Свободный", false), "Q3");
  assert.equal((await workTypeRoute.POST(f.request("POST", { ...type, requiredQualificationIds: ["Q3"] }))).status, 400);
  assert.equal((await workTypeRoute.PUT(f.request("PUT", { ...type, id: "MISSING" }))).status, 404);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM work_type_versions").get().n, count);
  const created = await catalogue.saveQualification(f.database, "ORG", input("Новый для типа"));
  const saved = await workTypeRoute.POST(f.request("POST", { ...type, name: "Новая работа", requiredQualificationIds: [created.id], requiredQualifications: [created.name] }));
  assert.equal(saved.status, 201);
  assert.deepEqual((await saved.json()).item.requiredQualificationIds, [created.id]);
});

test("engineer form saves multiple IDs without resetting document dates or individual statuses", async (t) => {
  const f = fixture(t);
  const initial = f.links();
  const data = await (await engineerRoute.GET(f.request())).json();
  assert.equal(data.qualifications.length, 5);
  const worker = data.items[0];
  assert.deepEqual([...worker.qualificationIds].sort(), ["Q1", "Q2"]);
  await catalogue.saveQualification(f.database, "ORG", input("Новое название"), "Q1");
  let response = await engineerRoute.PUT(f.request("PUT", { ...worker, warning: true }));
  assert.equal(response.status, 200);
  assert.deepEqual(f.links(), initial);
  assert.ok((await response.json()).item.qualificationNames.includes("Новое название"));
  const created = await catalogue.saveQualification(f.database, "ORG", input("Новый для исполнителя"));
  response = await engineerRoute.PUT(f.request("PUT", { ...worker, qualificationIds: ["Q1", "Q2", created.id] }));
  assert.equal(response.status, 200);
  assert.equal(f.links().length, 3);
  assert.deepEqual(f.links().filter((link) => link.qualification_id === "Q1" || link.qualification_id === "Q2"), initial);
  response = await engineerRoute.PUT(f.request("PUT", { ...worker, qualificationIds: ["Q1", created.id] }));
  assert.equal(response.status, 200);
  assert.deepEqual(f.links().find((link) => link.qualification_id === "Q1"), initial[0]);
  assert.ok(!f.links().some((link) => link.qualification_id === "Q2"));
});

test("invalid engineer selections are rejected, while legacy saves retain all existing links", async (t) => {
  const f = fixture(t);
  const worker = (await (await engineerRoute.GET(f.request())).json()).items[0];
  const initial = f.links();
  for (const ids of [["MISSING"], ["Q1", "Q1"], [false]]) assert.equal((await engineerRoute.PUT(f.request("PUT", { ...worker, qualificationIds: ids }))).status, 400);
  const legacy = { ...worker };
  delete legacy.qualificationIds;
  assert.equal((await engineerRoute.PUT(f.request("PUT", legacy))).status, 200);
  assert.deepEqual(f.links(), initial);
  assert.equal(isQualificationIds(["Q1", "Q2"]), true);
  assert.equal(isQualificationIds([" "]), false);
});

const require = createRequire(import.meta.url);
const reactImports = {
  "@/app/lib/regional-time": await sourceModule("../app/lib/regional-time.ts", { "@mmi/provider-contracts": await sourceModule("../../../packages/provider-contracts/src/regional-time.ts") }),
  react: pathToFileURL(require.resolve("react")).href,
  "react/jsx-runtime": pathToFileURL(require.resolve("react/jsx-runtime")).href,
  "@/app/components/material-icon": moduleUrl("export default function Icon() { return null; }"),
};
const choicesUrl = await sourceModule("../app/admin/qualification-choices.tsx", reactImports);
const skillChoicesUrl = await sourceModule("../app/admin/skill-choices.tsx", reactImports);
const catalogPanelUrl = await sourceModule("../app/admin/requirement-catalog-panel.tsx", {
  ...reactImports, "@/app/lib/api-client": await sourceModule("../app/lib/api-client.ts"),
});
const qualificationsPanelUrl = await sourceModule("../app/admin/qualifications-panel.tsx", {
  ...reactImports, "./requirement-catalog-panel": catalogPanelUrl,
});
const { default: SkillsAndQualificationsPanel } = await import(await sourceModule("../app/admin/skills-and-qualifications-panel.tsx", {
  ...reactImports, "./requirement-catalog-panel": catalogPanelUrl, "./qualifications-panel": qualificationsPanelUrl,
}));
const { default: WorkTypeEditor } = await import(await sourceModule("../app/admin/work-type-editor.tsx", {
  "@/app/lib/work-catalog": workCatalogUrl,
  ...reactImports, "./qualification-choices": choicesUrl,
  "./skill-choices": skillChoicesUrl,
  "./work-type-data": await sourceModule("../app/admin/work-type-data.ts"),
  "@/app/lib/planned-duration": routeImports["@/app/lib/planned-duration"],
}));
const { default: EngineerEditor } = await import(await sourceModule("../app/engineers/engineer-editor.tsx", {
  "./availability-panel": await sourceModule("../app/engineers/availability-panel.tsx", {...reactImports,"@/app/lib/api-client":await sourceModule("../app/lib/api-client.ts")}),
  "./equipment-panel": await sourceModule("../app/engineers/equipment-panel.tsx", {...reactImports,"@/app/lib/api-client":await sourceModule("../app/lib/api-client.ts")}),
  "@/app/components/work-competency-choices": await sourceModule("../app/components/work-competency-choices.tsx", reactImports),
  ...reactImports, "@/app/admin/qualification-choices": choicesUrl,
  "@/app/admin/skill-choices": skillChoicesUrl,
  "@/app/admin/work-schedule-data": await sourceModule("../app/admin/work-schedule-data.ts"),
}));
test("editors hide legacy qualification fields even when old records retain them", async (t) => {
  const f = fixture(t);
  const worker = (await (await engineerRoute.GET(f.request())).json()).items[0];
  const type = (await listWorkTypes(f.database, "ORG"))[0];
  await catalogue.saveQualification(f.database, "ORG", input("Новый русский допуск"), "Q1");
  await catalogue.saveQualification(f.database, "ORG", input("Свободный", false), "Q3");
  const qualifications = await catalogue.listQualifications(f.database, "ORG");
  const skills = await skillsCatalogue.listSkills(f.database, "ORG");
  const workerHtml = renderToStaticMarkup(createElement(EngineerEditor, { initialEngineer: worker, qualifications, skills, users: [], schedules: [], onClose() {}, onSave() {} }));
  const typeHtml = renderToStaticMarkup(createElement(WorkTypeEditor, { initialWorkType: type, qualifications, skills, onClose() {}, onSave() {} }));
  for (const html of [workerHtml, typeHtml]) {
    assert.doesNotMatch(html, /Новый русский допуск|Допуски и квалификации/);
    assert.doesNotMatch(html, /<span>Свободный<\/span>/);
    assert.doesNotMatch(html, /<span>Допуск 3<\/span>/);
  }
  assert.match(workerHtml, /Компетенции ВК/);
});

test("skills API persists shared entries and enforces permissions", async (t) => {
  const f = fixture(t);
  f.context.user = null;
  for (const method of ["GET", "POST", "PUT"]) assert.equal((await skillsRoute[method](f.request(method, method === "GET" ? undefined : { ...input("Навык"), id: "S1" }))).status, 401);
  f.context.user = { id: "USER" };
  assert.equal((await skillsRoute.POST(f.request("POST", input("Навык"), { origin: "https://foreign.invalid" }))).status, 403);
  let response = await skillsRoute.POST(f.request("POST", { ...input(" Обслуживание  кондиционеров "), organizationId: "OTHER" }));
  assert.equal(response.status, 201);
  const { item } = await response.json();
  assert.equal(item.name, "Обслуживание кондиционеров");
  assert.equal(f.db.prepare("SELECT organization_id FROM skills WHERE id=?").get(item.id).organization_id, "ORG");
  await assert.rejects(skillsCatalogue.saveSkill(f.database, "OTHER", input(item.name)), /уже существует/);
  const foreign = await skillsCatalogue.saveSkill(f.database, "OTHER", input("Общий навык"));
  response = await skillsRoute.GET(f.request());
  const rows = (await response.json()).items;
  assert.ok(rows.some(row => row.id === item.id));
  assert.ok(rows.some(row => row.id === foreign.id));
  assert.equal((await skillsRoute.PUT(f.request("PUT", { ...input("Изменено"), id: foreign.id }))).status, 200);
  f.db.exec("DELETE FROM role_permissions WHERE permission_code='admin.settings'");
  for (const method of ["GET", "POST", "PUT"]) assert.equal((await skillsRoute[method](f.request(method, method === "GET" ? undefined : { ...input("Навык"), id: "S1" }))).status, 403);
});

test("skill renaming preserves type versions, worker levels and confirmation dates", async (t) => {
  const f = fixture(t);
  f.db.exec("UPDATE worker_skills SET level='expert',confirmed_at='2026-01-15' WHERE skill_id='S1'; INSERT INTO work_type_version_skills VALUES ('V0','S1')");
  const worker = (await (await engineerRoute.GET(f.request())).json()).items[0];
  const type = (await listWorkTypes(f.database, "ORG"))[0];
  const before = f.db.prepare("SELECT * FROM worker_skills").all();
  const response = await skillsRoute.PUT(f.request("PUT", { id: "S1", ...input("Электромонтаж") }));
  assert.equal(response.status, 200);
  const { item } = await response.json();
  assert.equal(item.workerCount, 1);
  assert.equal(item.workTypeCount, 1);
  assert.deepEqual(f.db.prepare("SELECT * FROM worker_skills").all(), before);
  assert.deepEqual((await listWorkTypes(f.database, "ORG"))[0].requiredSkillIds, ["S1"]);
  assert.deepEqual((await listWorkTypes(f.database, "ORG"))[0].requiredSkills, ["Электромонтаж"]);
  // Forms opened before rename still save with their stable IDs and old labels.
  assert.equal((await workTypeRoute.PUT(f.request("PUT", type))).status, 200);
  assert.equal((await engineerRoute.PUT(f.request("PUT", worker))).status, 200);
  assert.deepEqual(f.db.prepare("SELECT * FROM worker_skills").all(), before);
});

test("skills validate names and protect used or historical-only records from deactivation", async (t) => {
  const f = fixture(t);
  for (const body of [input(" "), input("x".repeat(201)), { ...input("Навык"), active: 1 }, { ...input("Навык"), description: "x".repeat(2001) }]) assert.equal((await skillsRoute.POST(f.request("POST", body))).status, 400);
  assert.equal((await skillsRoute.POST(f.request("POST", input(" эЛеКтРиКа ")))).status, 409);
  assert.equal((await skillsRoute.PUT(f.request("PUT", { id: "S1", ...input("Электрика", false) }))).status, 409);
  const historical = await skillsCatalogue.saveSkill(f.database, "ORG", input("Исторический"));
  f.db.prepare("INSERT INTO work_type_version_skills VALUES ('V0',?)").run(historical.id);
  assert.equal((await skillsRoute.PUT(f.request("PUT", { ...historical, active: false }))).status, 409);
  const unused = await skillsCatalogue.saveSkill(f.database, "ORG", input("Свободный навык"));
  assert.equal((await skillsRoute.PUT(f.request("PUT", { ...unused, active: false }))).status, 200);
  assert.equal(await skillsCatalogue.resolveSkillIds(f.database, "ORG", { ids: [unused.id], names: [] }), null);
  assert.deepEqual(await skillsCatalogue.resolveSkillIds(f.database, "ORG", { ids: [unused.id], names: [] }, [unused.id]), [unused.id]);
  assert.equal((await skillsRoute.PUT(f.request("PUT", { ...unused, active: true }))).status, 200);
});

test("skills deactivation detects a concurrent assignment at the SQL write", async (t) => {
  const f = fixture(t);
  const unused = await skillsCatalogue.saveSkill(f.database, "ORG", input("Свободный"));
  const prepare = f.database.prepare;
  f.database.prepare = sql => {
    const statement = prepare(sql);
    if (sql.startsWith("UPDATE skills SET")) {
      const run = statement.run.bind(statement);
      statement.run = async () => { f.db.prepare("INSERT INTO worker_skills (worker_id,skill_id) VALUES ('EMP-1',?)").run(unused.id); return run(); };
    }
    return statement;
  };
  await assert.rejects(skillsCatalogue.saveSkill(f.database, "ORG", input("Отключение", false), unused.id), error => error.status === 409);
  assert.equal(f.db.prepare("SELECT active FROM skills WHERE id=?").get(unused.id).active, 1);
});

test("engineers and types can select new skills; saving preserves multiple assignments and metadata", async (t) => {
  const f = fixture(t);
  const added = await skillsCatalogue.saveSkill(f.database, "ORG", input("Диагностика насосов"));
  f.db.exec("UPDATE worker_skills SET level='expert',confirmed_at='2026-02-01' WHERE skill_id='S1'");
  const original = f.db.prepare("SELECT * FROM worker_skills WHERE skill_id='S1'").get();
  const worker = (await (await engineerRoute.GET(f.request())).json()).items[0];
  let response = await engineerRoute.PUT(f.request("PUT", { ...worker, skillIds: ["S1", added.id] }));
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).item.skillNames.sort(), ["Диагностика насосов", "Электрика"]);
  assert.deepEqual(f.db.prepare("SELECT * FROM worker_skills WHERE skill_id='S1'").get(), original);
  const legacy = { ...worker }; delete legacy.skillIds;
  assert.equal((await engineerRoute.PUT(f.request("PUT", legacy))).status, 200);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM worker_skills").get().n, 2);
  const type = (await listWorkTypes(f.database, "ORG"))[0];
  response = await workTypeRoute.POST(f.request("POST", { ...type, name: "Работа с новым навыком", requiredSkillIds: [added.id], requiredSkills: [added.name] }));
  assert.equal(response.status, 201);
  assert.deepEqual((await response.json()).item.requiredSkillIds, [added.id]);
  assert.equal((await engineerRoute.PUT(f.request("PUT", { ...worker, skillIds: [added.id] }))).status, 200);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM worker_skills WHERE skill_id='S1'").get().n, 0);
});

test("missing, duplicate, empty or inactive skill selections never change assignments", async (t) => {
  const f = fixture(t);
  const inactive = await skillsCatalogue.saveSkill(f.database, "ORG", input("Отключённый", false));
  const worker = (await (await engineerRoute.GET(f.request())).json()).items[0];
  const type = (await listWorkTypes(f.database, "ORG"))[0];
  const initial = f.db.prepare("SELECT * FROM worker_skills").all();
  for (const ids of [["MISSING"], [inactive.id], ["S1", "S1"], [], [123], [" "]]) {
    if (ids.length) assert.equal((await engineerRoute.PUT(f.request("PUT", { ...worker, skillIds: ids }))).status, 400);
    assert.equal((await workTypeRoute.PUT(f.request("PUT", { ...type, requiredSkillIds: ids }))).status, 400);
    assert.equal((await workTypeRoute.POST(f.request("POST", { ...type, requiredSkillIds: ids }))).status, 400);
  }
  assert.deepEqual(f.db.prepare("SELECT * FROM worker_skills").all(), initial);
});

test("editors use VK-HD competencies instead of legacy skill pickers", async (t) => {
  const f = fixture(t);
  const extra = await skillsCatalogue.saveSkill(f.database, "ORG", input("Ремонт насосов"));
  await skillsCatalogue.saveSkill(f.database, "ORG", input("Недоступный навык", false));
  f.db.prepare("INSERT INTO worker_skills (worker_id,skill_id) VALUES ('EMP-1',?)").run(extra.id);
  const worker = (await (await engineerRoute.GET(f.request())).json()).items[0];
  const type = (await listWorkTypes(f.database, "ORG"))[0];
  await skillsCatalogue.saveSkill(f.database, "ORG", input("Новое название навыка"), "S1");
  const skills = await skillsCatalogue.listSkills(f.database, "ORG");
  const qualifications = await catalogue.listQualifications(f.database, "ORG");
  const workerHtml = renderToStaticMarkup(createElement(EngineerEditor, { initialEngineer: worker, skills, qualifications, users: [], schedules: [], onClose() {}, onSave() {} }));
  const typeHtml = renderToStaticMarkup(createElement(WorkTypeEditor, { initialWorkType: type, skills, qualifications, onClose() {}, onSave() {} }));
  for (const html of [workerHtml, typeHtml]) {
    assert.doesNotMatch(html, /Новое название навыка|Необходимые навыки/);
    assert.doesNotMatch(html, /Недоступный навык/);
    assert.doesNotMatch(html, /<span>Клининг<\/span>/);
  }
  assert.match(workerHtml, /Компетенции ВК/);
});

test("combined requirements section renders both editable catalogues with independent loading states", async (t) => {
  const f = fixture(t);
  const props = {
    skills: await skillsCatalogue.listSkills(f.database, "ORG"),
    qualifications: await catalogue.listQualifications(f.database, "ORG"),
    skillsReady: true, qualificationsReady: true, onSkillSaved() {}, onQualificationSaved() {},
  };
  const html = renderToStaticMarkup(createElement(SkillsAndQualificationsPanel, props));
  assert.match(html, /role="tabpanel" aria-labelledby="admin-requirements-tab"/);
  assert.match(html, /<h2>Навыки<\/h2>/);
  assert.match(html, /<h2>Допуски и квалификации<\/h2>/);
  assert.match(html, /Добавить навык/);
  assert.match(html, /Добавить допуск/);
  assert.match(html, /<b>Электрика<\/b>/);
  assert.match(html, /<b>Допуск 1<\/b>/);
  const loading = renderToStaticMarkup(createElement(SkillsAndQualificationsPanel, { ...props, skillsReady: false }));
  assert.match(loading, /<button[^>]*disabled=""[^>]*>Добавить навык<\/button>/);
  assert.match(loading, /<button type="button" class="stitch-green-button">Добавить допуск<\/button>/);
  assert.match(loading, /<b>Допуск 1<\/b>/);
});

test("admin exposes one unified request catalog without legacy requirement tabs", async () => {
  const text = await readFile(new URL("../app/admin/admin-client.tsx", import.meta.url), "utf8");
  const source = ts.createSourceFile("admin-client.tsx", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const labels = [];
  function visit(node) {
    if (ts.isJsxElement(node) && node.openingElement.tagName.getText(source) === "button"
      && node.openingElement.attributes.properties.some(attribute => ts.isJsxAttribute(attribute)
        && attribute.name.getText(source) === "role" && attribute.initializer && ts.isStringLiteral(attribute.initializer) && attribute.initializer.text === "tab")) {
      labels.push(node.children.filter(ts.isJsxText).map(child => child.text.trim()).join(""));
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.deepEqual(labels, ["Настройки", "Пользователи", "Роли", "Типы заявок"]);
});
