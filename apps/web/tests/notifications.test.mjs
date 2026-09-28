import assert from "node:assert/strict";
import { before, after, beforeEach, afterEach, test } from "node:test";
import { isolatedWorker } from "./helpers/isolated-worker.mjs";
let app;
before(async () => { app = await isolatedWorker(); });
after(() => app?.close());
beforeEach(() => app.db.exec("SAVEPOINT notices"));
afterEach(() => app.db.exec("ROLLBACK TO notices; RELEASE notices"));

test("NOTICE-01 status transitions and independent problems persist, with per-user cursor and read state", async () => {
  const initial = await app.json("/api/notifications");
  assert.equal(initial.initialized, false);
  await app.json("/api/notifications", { method: "PUT", body: { action: "delivered", sequence: initial.latest } });
  app.db.exec("UPDATE work_orders SET status='assigned' WHERE id='ORD-9021'");
  app.db.exec("UPDATE work_orders SET status='assigned' WHERE id='ORD-9021'");
  const workerId = app.db.prepare("SELECT id FROM workers LIMIT 1").get().id;
  app.db.prepare("INSERT INTO mobile_issues VALUES ('independent-problem','ORD-9021',?,'Нет доступа','Нужен ключ от подъезда','2026-09-18T10:00:00Z')").run(workerId);
  const feed = await app.json("/api/notifications");
  assert.equal(feed.pending.length, 2, "same status update does not create a duplicate");
  assert.deepEqual(feed.pending.map(item => item.kind), ["status", "problem"]);
  assert.match(feed.pending[1].detail, /ключ/);
  const sequence = feed.pending[0].sequence;
  await app.json("/api/notifications", { method: "PUT", body: { action: "read", sequences: [sequence] } });
  await app.json("/api/notifications", { method: "PUT", body: { action: "delivered", sequence: feed.latest } });
  const reload = await app.json("/api/notifications");
  assert.deepEqual(reload.pending, []);
  assert.equal(reload.items.find(item => item.sequence === sequence).read, true);
  assert.equal(reload.unread, initial.unread + 1);
  assert.equal(app.db.prepare("SELECT COUNT(*) n FROM dispatcher_notification_reads WHERE user_id<>'QA-ADMIN'").get().n, 0);
});

test("NOTICE-02 events roll back with a failed write and other divisions cannot read or mark them", async () => {
  const initial = await app.json("/api/notifications");
  app.db.exec("SAVEPOINT failing_command; UPDATE work_orders SET status='assigned' WHERE id='ORD-9021'; ROLLBACK TO failing_command; RELEASE failing_command");
  assert.equal((await app.json("/api/notifications")).latest, initial.latest);
  app.db.exec("UPDATE work_orders SET status='assigned' WHERE id='ORD-9021'");
  const { latest } = await app.json("/api/notifications");
  const switched = await app.request("/api/organization-context", { method: "PUT", body: { organizationId: "ORG-002" } });
  const cookie = `${app.cookie}; ${switched.headers.get("set-cookie").split(";")[0]}`;
  const other = await app.json("/api/notifications", { cookie });
  assert.deepEqual(other.items, []);
  await app.json("/api/notifications", { method: "PUT", cookie, body: { action: "delivered", sequence: latest } }, 400);
  await app.json("/api/notifications", { method: "PUT", cookie, body: { action: "read", sequences: [latest] } });
  assert.equal(app.db.prepare("SELECT COUNT(*) n FROM dispatcher_notification_reads WHERE sequence=?").get(latest).n, 0);
  await app.json("/api/notifications", { cookie: "" }, 401);
  app.db.exec("DELETE FROM role_permissions WHERE role_id='administrator' AND permission_code='planning.manage'");
  await app.json("/api/notifications", {}, 403);
});

test("NOTICE-03 the journal paginates by sequence without repeating the page boundary", async () => {
  for (let i=0; i<61; i++) app.db.prepare("INSERT INTO dispatcher_notifications (organization_id,work_order_id,kind,detail,created_at) VALUES ('ORG-001','ORD-9021','problem',?,'2026-09-18T10:00:00Z')").run(`Событие ${i}`);
  const first = await app.json("/api/notifications");
  assert.equal(first.items.length, 50);
  const second = await app.json(`/api/notifications?before=${first.nextBefore}`);
  assert.equal(second.items.length, 11);
  assert.equal(new Set([...first.items, ...second.items].map(item => item.sequence)).size, 61);
  const number = app.db.prepare("SELECT number FROM work_orders WHERE id='ORD-9021'").get().number;
  assert.ok([...first.items, ...second.items].every(item => item.title === `Заявка № ${number} · Проблема`));
});

test("NOTICE-05 existing journal and new popups use the public number, retaining the internal link", async () => {
  const id = "beeline-app-v1-southcentral-job-18023";
  const order = { ...app.db.prepare("SELECT * FROM work_orders WHERE id='ORD-9021'").get(), id, number: "0017896" };
  const columns = Object.keys(order);
  app.db.prepare(`INSERT INTO work_orders (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`).run(...Object.values(order));
  app.db.prepare("INSERT INTO dispatcher_notifications (organization_id,work_order_id,kind,detail,created_at) VALUES ('ORG-001',?,'status','assigned','2026-09-18T10:00:00Z')").run(id);
  const history = await app.json('/api/notifications');
  assert.equal(history.items[0].title, 'Заявка № 0017896 · Назначена');
  assert.equal(history.items[0].orderId, id);
  await app.json('/api/notifications', { method: 'PUT', body: { action: 'delivered', sequence: history.latest } });
  app.db.prepare("UPDATE work_orders SET status='in_progress' WHERE id=?").run(id);
  app.db.prepare("INSERT INTO dispatcher_notifications (organization_id,work_order_id,kind,detail,created_at) VALUES ('ORG-001',?,'problem','Нет доступа','2026-09-18T11:00:00Z')").run(id);
  const feed = await app.json('/api/notifications');
  assert.deepEqual(feed.pending.map(item => item.title), ['Заявка № 0017896 · В работе', 'Заявка № 0017896 · Проблема']);
  assert.ok(feed.pending.every(item => item.orderId === id));
  assert.ok(feed.items.every(item => !item.title.includes('beeline-app')));
});

test("NOTICE-04 read all covers older pages only for this user and division, preserving later events", async () => {
  for(let i=0;i<61;i++) app.db.prepare("INSERT INTO dispatcher_notifications (organization_id,work_order_id,kind,detail,created_at) VALUES ('ORG-001','ORD-9021','problem',?,'2026-09-18T10:00:00Z')").run(`Событие ${i}`);
  const feed=await app.json('/api/notifications');
  app.db.exec("INSERT INTO dispatcher_notifications (organization_id,work_order_id,kind,detail,created_at) VALUES ('ORG-001','ORD-9021','problem','Новое событие','2026-09-18T11:00:00Z')");
  await app.json('/api/notifications',{method:'PUT',headers:{'X-MMI-Organization':'ORG-002'},body:{action:'read_all',throughSequence:feed.latest}});
  assert.equal((await app.json('/api/notifications')).unread,62);
  for(let i=0;i<2;i++) await app.json('/api/notifications',{method:'PUT',body:{action:'read_all',throughSequence:feed.latest}});
  const after=await app.json('/api/notifications');
  assert.equal(after.unread,1);
  assert.equal(after.cursor,feed.latest);
  assert.equal(after.pending.length,1,'read pages do not block later popup notifications');
  assert.equal(after.items[0].read,false);
  assert.equal(after.items.slice(1).every(item=>item.read),true);
  const older=await app.json(`/api/notifications?before=${after.nextBefore}`);
  assert.equal(older.items.every(item=>item.read),true);
  assert.equal(app.db.prepare("SELECT COUNT(*) n FROM dispatcher_notification_reads WHERE user_id<>'QA-ADMIN'").get().n,0);
  for(const throughSequence of [-1,1.5,'123',null]) await app.json('/api/notifications',{method:'PUT',body:{action:'read_all',throughSequence}},400);
});
