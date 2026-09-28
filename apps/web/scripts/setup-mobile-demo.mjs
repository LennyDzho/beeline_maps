import { DatabaseSync } from "node:sqlite";
import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { pbkdf2Sync, randomBytes } from "node:crypto";
import path from "node:path";

export const DEMO_EMAIL = "mobile.demo@marsh.test";
export const DEMO_PASSWORD = "MarshDemo2026!";
export async function localDatabase() {
  const folder = fileURLToPath(new URL("../.wrangler/state/v3/d1/miniflare-D1DatabaseObject/", import.meta.url));
  const files = (await readdir(folder)).filter(name => /^[a-f0-9]{64}\.sqlite$/u.test(name));
  if (files.length !== 1) throw new Error("Expected one local D1 database.");
  const db = new DatabaseSync(path.join(folder, files[0]));
  db.exec("PRAGMA busy_timeout = 10000; PRAGMA foreign_keys = ON;");
  return db;
}
export function createFixture(db, prefix, email, password, count = 3) {
  const userId = `USR-${prefix}`, workerId = `EMP-${prefix}`;
  const now = new Date().toISOString();
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Moscow", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const organizationId = "ORG-001";
  const role = db.prepare("SELECT id FROM roles WHERE organization_id = ? AND code = 'executor'").get(organizationId);
  if (!role) throw new Error("Sign in to the local main application once to initialize its data.");
  const salt = randomBytes(16);
  const passwordHash = pbkdf2Sync(password, salt, 210000, 32, "sha256").toString("base64");
  const sourceWorker = db.prepare("SELECT * FROM workers WHERE organization_id = ? AND id = 'EMP-402'").get(organizationId);
  const sourceOrder = db.prepare("SELECT * FROM work_orders WHERE organization_id = ? AND assignee_worker_id = 'EMP-402' LIMIT 1").get(organizationId);
  if (!sourceWorker || !sourceOrder) throw new Error("Local reference records are missing.");
  const insertClone = (table, record) => {
    const keys = Object.keys(record);
    db.prepare(`INSERT OR IGNORE INTO ${table} (${keys.map(k => `"${k}"`).join(",")}) VALUES (${keys.map(() => "?").join(",")})`).run(...keys.map(k => record[k]));
  };
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(`INSERT OR IGNORE INTO users (id, email, display_name, role, password_salt, password_hash, password_iterations, must_change_password, status, created_at, updated_at)
      VALUES (?, ?, ?, 'executor', ?, ?, 210000, 0, 'active', ?, ?)`).run(userId, email, "Тестовый инженер Марш!", salt.toString("base64"), passwordHash, now, now);
    db.prepare(`INSERT OR IGNORE INTO memberships (id, organization_id, user_id, role_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'active', ?, ?)`)
      .run(`MEM-${prefix}`, organizationId, userId, role.id, now, now);
    insertClone("workers", { ...sourceWorker, id: workerId, user_id: userId, employee_number: prefix, full_name: "Тестовый инженер Марш!", phone: "+7 900 000-00-00", shift_status: "on_shift", created_at: now, updated_at: now });
    const workerSkills = db.prepare("SELECT * FROM worker_skills WHERE worker_id = ?").all(sourceWorker.id);
    for (const skill of workerSkills) insertClone("worker_skills", { ...skill, worker_id: workerId });
    const qualifications = db.prepare("SELECT * FROM worker_qualifications WHERE worker_id = ?").all(sourceWorker.id);
    for (const qualification of qualifications) insertClone("worker_qualifications", { ...qualification, worker_id: workerId });
    for (let i = 1; i <= count; i++) {
      const id = `ANDROID-${prefix}-${i}`;
      insertClone("work_orders", { ...sourceOrder, id, number: id, assignee_worker_id: workerId, status: "assigned", revision: 0,
        description: `Проверка Android «Марш!»: задание ${i}. Зафиксируйте результат фото или видео.`, priority: i === 1 ? "high" : "medium",
        scheduled_start: `${date}T${String(8 + i * 2).padStart(2, "0")}:00`, scheduled_end: `${date}T${String(9 + i * 2).padStart(2, "0")}:00`,
        completed_at: null, confirmed_at: null, confirmed_by_user_id: null, created_at: now, updated_at: now });
      db.prepare(`INSERT OR IGNORE INTO work_order_status_history (id, work_order_id, from_status, to_status, changed_by_user_id, reason, created_at) VALUES (?, ?, NULL, 'assigned', ?, 'Локальное тестовое назначение Android', ?)`)
        .run(`EVENT-${id}`, id, userId, now);
    }
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
  return { userId, workerId, organizationId, email, password, date, orderIds: Array.from({length:count}, (_,i) => `ANDROID-${prefix}-${i+1}`) };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const db = await localDatabase(); createFixture(db, "DEMO", DEMO_EMAIL, DEMO_PASSWORD); db.close();
  console.log("Local Android demo account and three assignments are ready. Existing demo work was preserved.");
}
