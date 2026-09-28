import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";

test("regional migration only adds columns, preserving existing orders, histories, worker settings and access details", async () => {
  const db = new DatabaseSync(":memory:");
  const root = new URL("../drizzle/", import.meta.url);
  try {
    for (const file of (await readdir(root)).filter(file => /^00(?:0\d|10)_.*\.sql$/u.test(file)).sort()) db.exec(await readFile(new URL(file, root), "utf8"));
    db.exec(`PRAGMA foreign_keys=ON;
      INSERT INTO users(id,email,display_name,role,password_salt,password_hash,password_iterations,status,created_at,updated_at)
        VALUES ('U','test@example.invalid','Тест','administrator','salt','hash',1,'active','now','now');
      INSERT INTO organizations(id,name,timezone,status,created_at,updated_at) VALUES ('O','Подразделение','Asia/Irkutsk','active','now','now');
      INSERT INTO work_types(id,organization_id,code,name,created_at,updated_at) VALUES ('T','O','T','Работа','now','now');
      INSERT INTO work_type_versions(id,work_type_id,version,status,verification_mode,created_at) VALUES ('V','T',1,'published','dispatcher','now');
      INSERT INTO workers(id,organization_id,employee_number,full_name,phone,created_at,updated_at) VALUES ('W','O','1','Бригада','123','now','now');
      INSERT INTO work_orders(id,organization_id,number,work_type_version_id,created_by_user_id,status,scheduled_start,address_snapshot,created_at,updated_at)
        VALUES ('J','O','1','V','U','paused','2026-08-17T09:00','Москва, Дом 1, кв. 2','now','now');
      INSERT INTO work_order_status_history(id,work_order_id,to_status,changed_by_user_id,created_at) VALUES ('H','J','paused','U','now');`);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
    const before = tables.map(({ name }) => ({ name, columns: db.prepare(`PRAGMA table_info("${name}")`).all().map(item => item.name), rows: db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all() }));
    db.exec(await readFile(new URL("0011_regional_scheduling.sql", root), "utf8"));
    for (const table of before) assert.deepEqual(db.prepare(`SELECT ${table.columns.map(column => `"${column}"`).join(",")} FROM "${table.name}" ORDER BY rowid`).all(), table.rows, table.name);
    assert.equal(db.prepare("SELECT client_window_start FROM work_orders WHERE id='J'").get().client_window_start, null);
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
  } finally { db.close(); }
});
