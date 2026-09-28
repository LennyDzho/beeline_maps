import assert from "node:assert/strict";
import { before, after, beforeEach, afterEach, test } from "node:test";
import { isolatedWorker } from "./helpers/isolated-worker.mjs";

let app;
before(async () => { app = await isolatedWorker(); });
after(() => app?.close());
beforeEach(() => app.db.exec("SAVEPOINT catalog"));
afterEach(() => app.db.exec("ROLLBACK TO catalog; RELEASE catalog"));

async function setup() {
  const { item: bk } = await app.json("/api/admin/work-categories", { method: "POST", body: { name: "Монтаж", description: "", active: true } }, 201);
  const { item: equipment } = await app.json("/api/admin/equipment", { method: "POST", body: { name: "Кабель", unit: "м", usage: "consumable", active: true } }, 201);
  const createHd = async (name, quantity, minutes) => (await app.json("/api/admin/work-types", { method: "POST", body: {
    name, description: "", categoryIds: [bk.id], plannedDurationMinutes: minutes, verificationMethodId: "dispatcher",
    requiredSkills: [], requiredQualifications: [], requiredSkillIds: [], requiredQualificationIds: [], equipmentRequirements: [{ equipmentId: equipment.id, quantity }],
  } }, 201)).item;
  const hd = [await createHd("Заказ подключения", 10, 70), await createHd("Дозаказ оборудования", 5, 20)];
  const worker = (await app.json("/api/engineers")).items[0];
  const assignCompetencies = async (types) => (await app.json("/api/engineers", { method: "PUT", body: {
    ...worker, skill: "", clearance: "", skillIds: [], qualificationIds: [],
    workCompetencies: types.map(item => ({ categoryId: bk.id, workTypeId: item.id })),
  } })).item;
  await assignCompetencies(hd);
  const body = { categoryId: bk.id, workTypeIds: hd.map(item => item.id), work: hd.map(item => item.name).join(" + "),
    serviceDurationMinutes: 80, durationSource: "Общий норматив без дороги", description: "Один выезд", priority: "medium", status: "new",
    dateTime: "2026-08-17T10:00", clientWindowStart: "2026-08-17T09:00", clientWindowEnd: "2026-08-17T12:00", address: "Москва, Тестовая, 1", assignee: "" };
  return { bk, equipment, hd, worker, body, assignCompetencies };
}

test("CAT-01 canonical HD aliases, one composite visit, immutable duration and equipment snapshots", async () => {
  const f = await setup();
  assert.equal(f.hd[0].name, "Заявка на подключение");
  await app.json("/api/admin/work-types", { method: "POST", body: { ...f.hd[0], name: "Заявка на подключение" } }, 409);
  const before = app.db.prepare("SELECT COUNT(*) AS n FROM work_orders").get().n;
  const { item } = await app.json("/api/requests", { method: "POST", body: f.body }, 201);
  assert.equal(app.db.prepare("SELECT COUNT(*) AS n FROM work_orders").get().n, before + 1);
  assert.equal(item.workTypeIds.length, 2);
  assert.equal(item.serviceDurationMinutes, 80);
  assert.equal(item.equipment[0].quantity, 15);
  assert.equal(app.db.prepare("SELECT scheduled_end FROM work_orders WHERE id=?").get(item.id).scheduled_end, "2026-08-17T11:20");
  await app.json("/api/admin/work-types", { method: "PUT", body: { ...f.hd[0], plannedDurationMinutes: 120, equipmentRequirements: [{ equipmentId: f.equipment.id, quantity: 50 }] } });
  await app.json("/api/admin/equipment", { method: "PUT", body: { ...f.equipment, name: "Новый кабель", unit: "катушка" } });
  const { item: saved } = await app.json("/api/requests", { method: "PUT", body: { ...item, description: "Правка описания" } });
  assert.deepEqual(saved.workTypeVersionIds, item.workTypeVersionIds);
  assert.equal(saved.serviceDurationMinutes, 80);
  assert.deepEqual(saved.equipment, item.equipment);
  // Old clients send no new fields and must preserve all composition metadata.
  const { item: legacy } = await app.json("/api/requests", { method: "PUT", body: {
    id: saved.id, work: saved.work, description: "Старый клиент", priority: saved.priority, status: saved.status, dateTime: saved.dateTime, address: saved.address, assignee: "", revision: saved.revision,
  } });
  assert.deepEqual(legacy.workTypeVersionIds, item.workTypeVersionIds);
  assert.deepEqual(legacy.equipment, item.equipment);
});

test("CAT-02 all HD competencies are necessary, no fabricated skill or qualification is required", async () => {
  const f = await setup();
  await f.assignCompetencies([f.hd[0]]);
  const assigned = { ...f.body, assignee: f.worker.name, assigneeId: f.worker.id, status: "assigned" };
  await app.json("/api/requests", { method: "POST", body: assigned }, 400);
  await f.assignCompetencies(f.hd);
  // Historical skill/qualification requirements no longer restrict VK-HD competent brigades.
  app.db.prepare("INSERT INTO work_type_version_skills(work_type_version_id,skill_id) SELECT ?,id FROM skills LIMIT 1").run(f.hd[0].versionId);
  app.db.prepare("INSERT INTO work_type_version_qualifications(work_type_version_id,qualification_id) SELECT ?,id FROM qualifications LIMIT 1").run(f.hd[0].versionId);
  app.db.prepare("DELETE FROM worker_skills WHERE worker_id=?").run(f.worker.id);
  app.db.prepare("DELETE FROM worker_qualifications WHERE worker_id=?").run(f.worker.id);
  const result = await app.json("/api/requests", { method: "POST", body: assigned }, 201);
  assert.equal(result.item.assigneeId, f.worker.id);
  assert.deepEqual(result.item.requiredSkills, []);
  assert.deepEqual(result.item.requiredQualifications, []);
});

test("CAT-03 composite duration must be explicit; wrong BK, foreign HD, equipment and competencies are rejected", async () => {
  const f = await setup();
  for (const patch of [{ serviceDurationMinutes: undefined }, { durationSource: "" }, { categoryId: "foreign" }, { workTypeIds: [f.hd[0].id, "foreign"] }]) {
    await app.json("/api/requests", { method: "POST", body: { ...f.body, ...patch } }, 400);
  }
  await app.json("/api/requests", { method: "POST", body: { ...f.body, categoryId: "", workTypeIds: undefined, work: f.hd[0].name } }, 400);
  await app.json("/api/admin/work-types", { method: "PUT", body: { ...f.hd[0], equipmentRequirements: [{ equipmentId: "foreign", quantity: 1 }] } }, 400);
  await app.json("/api/engineers", { method: "PUT", body: { ...f.worker, workCompetencies: [{ categoryId: f.bk.id, workTypeId: "foreign" }] } }, 400);
  await app.json("/api/admin/work-categories", { method: "PUT", body: { ...f.bk, id: "foreign" } }, 404);
  await app.json("/api/admin/equipment", { method: "PUT", body: { ...f.equipment, id: "foreign" } }, 404);
});

test("CAT-04 the planner uses all HD and the combined service time, one order counts once", async () => {
  const f = await setup();
  // Keep exactly this job in the calculation and one available worker.
  app.db.exec("UPDATE work_orders SET status='cancelled'");
  app.db.prepare("UPDATE workers SET active=0 WHERE id<>?").run(f.worker.id);
  app.db.prepare("UPDATE workers SET shift_status='on_shift', transport_mode='car' WHERE id=?").run(f.worker.id);
  await app.json("/api/admin/settings", { method: "PUT", body: { appName: "Марш!", timezone: "Europe/Moscow", emailAlerts: true, weeklyDigest: false, optimizationEngine: "pyvrp", travelMatrixProvider: "osrm" } });
  const { item } = await app.json("/api/requests", { method: "POST", body: f.body }, 201);
  await f.assignCompetencies([f.hd[0]]);
  const missed = await app.json("/api/planning", { method: "POST", body: { serviceDate: "2026-08-17" } }, 201);
  assert.equal(missed.result.metrics.plannedJobs, 0);
  await f.assignCompetencies(f.hd);
  const result = await app.json("/api/planning", { method: "POST", body: { serviceDate: "2026-08-17" } }, 201);
  assert.equal(result.result.metrics.totalJobs, 1);
  assert.equal(result.result.metrics.plannedJobs, 1);
  const visit = result.result.routes[0].visits[0];
  assert.equal(visit.jobId, item.id);
  assert.equal((Date.parse(visit.serviceEndAt) - Date.parse(visit.serviceStartAt)) / 60000, 80);
  // A changed competency invalidates a saved plan before publication.
  await f.assignCompetencies([f.hd[0]]);
  await app.json("/api/planning", { method: "PUT", body: { planId: result.result.planId } }, 409);
});

test("CAT-05 equipment report uses saved snapshots and draft assignments exactly once", async () => {
  const f = await setup();
  app.db.exec("UPDATE work_orders SET status='cancelled'");
  const { item } = await app.json("/api/requests", { method: "POST", body: { ...f.body, assignee: f.worker.name, assigneeId: f.worker.id, status: "assigned" } }, 201);
  let result = await app.json("/api/planning/equipment?date=2026-08-17");
  assert.equal(result.report.requestCount, 1);
  assert.equal(result.report.groups[0].workerId, f.worker.id);
  assert.equal(result.report.groups[0].items[0].quantity, 15);
  // A saved draft with no assigned stop moves that candidate into unassigned.
  app.db.prepare("UPDATE workers SET active=0 WHERE id<>?").run(f.worker.id);
  await f.assignCompetencies([f.hd[0]]);
  const { result: plan } = await app.json("/api/planning", { method: "POST", body: { serviceDate: "2026-08-17" } }, 201);
  result = await app.json(`/api/planning/equipment?date=2026-08-17&planId=${plan.planId}`);
  assert.equal(result.report.requestCount, 1);
  assert.equal(result.report.groups.length, 1);
  assert.equal(result.report.groups[0].workerId, null);
  assert.deepEqual(result.report.groups[0].items[0].requests, [{ id: item.id, number: item.number, quantity: 15 }]);
  assert.equal((await app.json(`/api/planning/equipment?date=2026-08-17&planId=${plan.planId}&workerId=${f.worker.id}`)).report.requestCount, 0);
  await f.assignCompetencies(f.hd);
  await app.json(`/api/planning/equipment?date=2026-08-17&planId=${plan.planId}`, {}, 409);
  await app.json("/api/planning/equipment?date=2026-08-17&planId=foreign", {}, 404);
  await app.json("/api/planning/equipment?date=2026-99-99", {}, 400);
});

test("CAT-06 unknown quantities remain unknown instead of becoming a false total", async () => {
  const f = await setup();
  await app.json("/api/admin/work-types", { method: "PUT", body: { ...f.hd[1], equipmentRequirements: [{ equipmentId: f.equipment.id, quantity: null }] } });
  const { item } = await app.json("/api/requests", { method: "POST", body: f.body }, 201);
  assert.equal(item.equipment[0].quantity, null);
  const { report } = await app.json("/api/planning/equipment?date=2026-08-17&workerId=unassigned");
  assert.equal(report.groups.find(group => group.workerId === null).items[0].quantity, null);
});

test("CAT-07 a BK norm controls single and composite visits, and remains a snapshot after editing the catalog", async () => {
  const f = await setup();
  const norm = { ...f.bk, serviceDurationMinutes: 70, durationSource: "Нормативы.xlsx C2+D2 без дороги" };
  await app.json("/api/admin/work-categories", { method: "PUT", body: norm });
  const single = (await app.json("/api/requests", { method: "POST", body: { ...f.body, workTypeIds: [f.hd[1].id], work: f.hd[1].name } }, 201)).item;
  assert.equal(single.serviceDurationMinutes, 70, "BK norm overrides the HD default of 20");
  const combined = (await app.json("/api/requests", { method: "POST", body: { ...f.body, serviceDurationMinutes: undefined, durationSource: undefined } }, 201)).item;
  assert.equal(combined.serviceDurationMinutes, 70, "one BK normative per visit, no sum of components");
  await app.json("/api/admin/work-categories", { method: "PUT", body: { ...norm, serviceDurationMinutes: 90 } });
  const saved = (await app.json("/api/requests", { method: "PUT", body: { ...single, description: "Only description changed" } })).item;
  assert.equal(saved.serviceDurationMinutes, 70);
  await app.json("/api/admin/work-categories", { method: "PUT", body: { ...norm, serviceDurationMinutes: 0 } }, 400);
  await app.json("/api/admin/work-categories", { method: "PUT", body: { ...norm, durationSource: "" } }, 400);
});

test("CAT-08 synthetic brigades can be edited without inventing a phone, account, plate or service area", async () => {
  const f = await setup();
  const saved = (await app.json("/api/engineers", { method: "PUT", body: { ...f.worker, workCompetencies: f.hd.map(type => ({ categoryId: f.bk.id, workTypeId: type.id })), skill: "", clearance: "", skillIds: [], qualificationIds: [], phone: "", userId: "", section: "", transport: "", transportType: "car" } })).item;
  assert.equal(saved.phone, ""); assert.equal(saved.userId, "");
  assert.equal(app.db.prepare("SELECT user_id FROM workers WHERE id=?").get(saved.id).user_id, null);
});

test("CAT-09 catalog edits and HD versions are shared, while orders and worker assignments remain regional", async () => {
  const f=await setup(),cookie=`${app.cookie}; mmi_organization=ORG-002`;
  const original=(await app.json('/api/requests',{method:'POST',body:f.body},201)).item;
  for(const key of ['workTypes','skills','qualifications','workCategories','equipmentItems']) {
    assert.deepEqual((await app.json('/api/admin/bootstrap',{cookie}))[key],(await app.json('/api/admin/bootstrap'))[key]);
  }
  const edited=(await app.json('/api/admin/work-types',{method:'PUT',cookie,body:{...f.hd[0],verificationMethodId:'automatic',plannedDurationMinutes:100}})).item;
  assert.equal((await app.json('/api/admin/bootstrap')).workTypes.find(t=>t.id===edited.id).verificationMethodId,'automatic');
  assert.deepEqual((await app.json('/api/requests')).items.find(j=>j.id===original.id).workTypeVersionIds,original.workTypeVersionIds);
  const second=(await app.json('/api/requests',{method:'POST',cookie,body:f.body},201)).item;
  assert.ok(second.workTypeVersionIds.includes(edited.versionId));
  await app.json('/api/requests',{method:'PUT',cookie,body:{...original,description:'Wrong subdivision'}},404);
  await app.json('/api/engineers',{method:'PUT',cookie,body:f.worker},404);
  await app.json('/api/admin/work-categories',{method:'POST',cookie,body:{...f.bk,id:undefined}},409);
  await app.json('/api/admin/equipment',{method:'POST',cookie,body:{...f.equipment,id:undefined}},409);
});
