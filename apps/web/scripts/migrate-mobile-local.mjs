import { DatabaseSync } from "node:sqlite";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

// Local-only migration runner for the existing Vite/Miniflare D1 database.
const root = fileURLToPath(new URL("../", import.meta.url));
const folder = path.join(root, ".wrangler/state/v3/d1/miniflare-D1DatabaseObject");
const candidates = (await readdir(folder)).filter(name => /^[a-f0-9]{64}\.sqlite$/u.test(name));
if (candidates.length !== 1) throw new Error("Expected exactly one local application database; no database changed.");
const db = new DatabaseSync(path.join(folder, candidates[0]));
db.exec("PRAGMA busy_timeout = 10000; PRAGMA foreign_keys = ON;");
const migration = await readFile(path.join(root, "drizzle/0009_wide_morbius.sql"), "utf8");
const applied = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'mobile_commands'").get();
if (!applied) {
  db.exec("BEGIN IMMEDIATE");
  try { for (const statement of migration.split("--> statement-breakpoint").map(v => v.trim()).filter(Boolean)) db.exec(statement); db.exec("COMMIT"); }
  catch (error) { db.exec("ROLLBACK"); throw error; }
  console.log("Mobile schema and work-order revision trigger applied to local D1.");
} else {
  if (!db.prepare("PRAGMA table_info(work_orders)").all().some(c => c.name === "revision")) throw new Error("Mobile schema is incomplete; manual inspection required.");
  console.log("Mobile schema already present; no migration repeated.");
}
db.prepare("UPDATE organizations SET application_name = 'Марш!' WHERE application_name IN ('Маршрут', 'Маршрут FSM')").run();
db.close();
