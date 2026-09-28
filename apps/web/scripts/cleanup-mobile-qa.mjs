import { localDatabase } from "./setup-mobile-demo.mjs";

// Only temporary records made by verify-mobile-api.mjs; the reviewable DEMO account stays.
const db = await localDatabase();
const fixtures = db.prepare("SELECT id, email FROM users WHERE id GLOB 'USR-QA-*' AND display_name = 'Тестовый инженер Марш!'").all()
  .filter(u => /^USR-QA-\d{13}(-B)?$/.test(u.id) && u.email === `${u.id.slice(4).toLowerCase()}@marsh.test`);
const orders = [];
for (const user of fixtures) {
  const workerId = `EMP-${user.id.slice(4)}`;
  const worker = db.prepare("SELECT user_id FROM workers WHERE id=?").get(workerId);
  if (worker?.user_id !== user.id) throw new Error("QA worker binding changed; no cleanup performed.");
  const assigned = db.prepare("SELECT id,description FROM work_orders WHERE assignee_worker_id=?").all(workerId);
  if (assigned.some(o => !o.id.startsWith(`ANDROID-${user.id.slice(4)}-`) || !o.description.startsWith("Проверка Android «Марш!»:"))) throw new Error("QA worker has other work; no cleanup performed.");
  orders.push(...assigned.map(o => o.id));
}
console.log(JSON.stringify({temporaryAccounts:fixtures.length,temporaryOrders:orders.length,keptAccount:"mobile.demo@marsh.test"}));
if (process.argv.includes("--apply")) {
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const id of orders) {
      db.prepare("DELETE FROM audit_events WHERE entity_id=?").run(id);
      db.prepare("DELETE FROM work_orders WHERE id=?").run(id);
    }
    for (const user of fixtures) {
      db.prepare("DELETE FROM audit_events WHERE actor_user_id=? OR entity_id=?").run(user.id, `EMP-${user.id.slice(4)}`);
      db.prepare("DELETE FROM workers WHERE id=? AND user_id=?").run(`EMP-${user.id.slice(4)}`,user.id);
      db.prepare("DELETE FROM users WHERE id=?").run(user.id);
    }
    db.exec("COMMIT"); console.log("Temporary API-test records removed; DEMO reports preserved.");
  } catch(error) { db.exec("ROLLBACK"); throw error; }
}
db.close();
