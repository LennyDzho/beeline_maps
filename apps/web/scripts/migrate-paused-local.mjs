import assert from "node:assert/strict";
import { DatabaseSync, backup } from "node:sqlite";
import { readFile, readdir, mkdir } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
export const migrationName = "0010_nifty_stature";
const quote = value => `"${value.replaceAll('"', '""')}"`;

// Compare actual content, not only row counts, including reports, media and audit.
export function databaseInventory(db) {
  return Object.fromEntries(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(({name}) => {
    const rows = db.prepare(`SELECT * FROM ${quote(name)}`).all().map(row => JSON.stringify(Object.fromEntries(Object.entries(row).sort(([a], [b]) => a.localeCompare(b))))).sort();
    return [name, { count: rows.length, hash: createHash("sha256").update(JSON.stringify(rows)).digest("hex") }];
  }));
}

export async function migratePaused(db) {
  const schema = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='work_orders'").get()?.sql;
  if (!schema) throw new Error("Application work_orders table is missing; no changes made.");
  if (schema.includes("'paused'")) return { changed: false };
  if (!db.prepare("SELECT name FROM sqlite_master WHERE name='mobile_issues'").get()) throw new Error("Apply migration 0009 first; no changes made.");
  const sql = await readFile(path.join(root, "drizzle", `${migrationName}.sql`), "utf8");
  const before = databaseInventory(db);
  // Table reconstruction must run OFFLINE with FK enforcement disabled before
  // BEGIN; defer_foreign_keys alone does NOT prevent ON DELETE CASCADE data loss.
  db.exec("PRAGMA foreign_keys=OFF");
  assert.equal(db.prepare("PRAGMA foreign_keys").get().foreign_keys, 0);
  db.exec("BEGIN EXCLUSIVE");
  try {
    for (const statement of sql.split("--> statement-breakpoint").map(s => s.trim()).filter(Boolean)) {
      if (/^PRAGMA foreign_keys\s*=/i.test(statement)) continue;
      db.exec(statement);
    }
    assert.deepEqual(databaseInventory(db), before, "Migration must preserve every existing row exactly");
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
    if (db.prepare("SELECT name FROM sqlite_master WHERE name='domain_schema_migrations'").get()) {
      db.prepare("INSERT OR IGNORE INTO domain_schema_migrations(name, applied_at) VALUES (?, ?)").run(migrationName, new Date().toISOString());
    }
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
  finally { db.exec("PRAGMA foreign_keys=ON"); }
  return { changed: true, preservedRows: Object.fromEntries(Object.entries(before).map(([table, data]) => [table, data.count])) };
}

async function serverRunning() {
  return new Promise(resolve => {
    const socket = createConnection({host:"127.0.0.1", port:3000});
    socket.setTimeout(1000);
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("error", () => { socket.destroy(); resolve(false); });
    socket.once("timeout", () => { socket.destroy(); resolve(true); });
  });
}

async function main() {
  const apply = process.argv.includes("--apply");
  if (apply && await serverRunning()) throw new Error("Stop the local server before --apply. No data changed.");
  const folder = path.join(root, ".wrangler/state/v3/d1/miniflare-D1DatabaseObject");
  const files = (await readdir(folder)).filter(name => /^[a-f0-9]{64}\.sqlite$/.test(name));
  if (files.length !== 1) throw new Error("Expected exactly one application database; no changes made.");
  const sourcePath = path.join(folder, files[0]);
  const output = path.join(root, ".tmp/paused-migration");
  await mkdir(output, {recursive:true});
  const stamp = `${new Date().toISOString().replaceAll(":", "-")}-${randomUUID()}`;
  const backupPath = path.join(output, `${stamp}-backup.sqlite`);
  const validationPath = path.join(output, `${stamp}-validation.sqlite`);
  const source = new DatabaseSync(sourcePath, {readOnly:true});
  try { await backup(source, backupPath); await backup(source, validationPath); } finally { source.close(); }
  const validation = new DatabaseSync(validationPath);
  try { console.log("copyValidation", JSON.stringify(await migratePaused(validation))); } finally { validation.close(); }
  if (apply) {
    const live = new DatabaseSync(sourcePath);
    try { console.log("applied", JSON.stringify(await migratePaused(live))); } finally { live.close(); }
  }
  console.log(JSON.stringify({applied:apply, backupPath, validationPath}));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
