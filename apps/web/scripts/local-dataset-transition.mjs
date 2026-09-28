import assert from 'node:assert/strict';
import { DatabaseSync, backup } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { createConnection } from 'node:net';
import { cp, mkdir, readFile, readdir, realpath, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { databaseInventory, migratePaused } from './migrate-paused-local.mjs';
import { manifest, importBeelineIntoEmptyDatabase } from './lib/beeline-import.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const stateRoot = path.join(root, '.wrangler/state/v3');
const outputRoot = path.join(root, '.tmp/dataset-transition');
const quote = name => `"${name.replaceAll('"', '""')}"`;
const preserved = new Set(['users', 'sessions', 'auth_login_attempts', 'permissions', 'domain_schema_migrations', '_cf_METADATA', '__drizzle_migrations', 'd1_migrations']);
const tables = db => db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(r => r.name);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const exists = async file => { try { await stat(file); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } };

export function d1Adapter(db) {
  return {
    prepare(sql) { return {
      values: [], bind(...values) { this.values = values; return this; },
      async first() { return db.prepare(sql).get(...this.values) ?? null; },
      async run() { return db.prepare(sql).run(...this.values); },
    }; },
    async batch(statements) {
      db.exec('SAVEPOINT dataset_import');
      try { const rows = []; for (const s of statements) rows.push(await s.run()); db.exec('RELEASE dataset_import'); return rows; }
      catch (e) { db.exec('ROLLBACK TO dataset_import; RELEASE dataset_import'); throw e; }
    },
  };
}

export async function upgradeSchema(db) {
  // The existing populated installation must already have the mobile upgrade.
  assert.ok(tables(db).includes('mobile_commands'), 'Apply the backed-up mobile migration first');
  await migratePaused(db);
  db.exec('PRAGMA foreign_keys=ON; BEGIN IMMEDIATE');
  try {
    for (const name of (await readdir(path.join(root, 'drizzle'))).filter(n => /^\d+_.+\.sql$/.test(n) && Number(n.slice(0, 4)) >= 11).sort()) {
      const version = name.slice(0, -4);
      if (db.prepare('SELECT name FROM domain_schema_migrations WHERE name=?').get(version)) continue;
      db.exec(await readFile(path.join(root, 'drizzle', name), 'utf8'));
      db.prepare('INSERT INTO domain_schema_migrations VALUES (?,?)').run(version, new Date().toISOString());
    }
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

async function expectedTables() {
  const db = new DatabaseSync(':memory:');
  try {
    for (const name of (await readdir(path.join(root, 'drizzle'))).filter(n => /^\d+_.+\.sql$/.test(n)).sort()) db.exec(await readFile(path.join(root, 'drizzle', name), 'utf8'));
    return new Set([...tables(db), ...preserved]);
  } finally { db.close(); }
}

export function verifyDataset(db) {
  const installed = db.prepare('SELECT version,content_hash FROM dataset_imports').all();
  assert.equal(installed.length, 1); assert.equal(installed[0].version, manifest.datasetVersion); assert.equal(installed[0].content_hash, manifest.contentHash);
  assert.equal(db.prepare('SELECT version FROM application_dataset WHERE id=1').get()?.version, manifest.datasetVersion);
  for (const [table, expected] of [['organizations', 3], ['workers', 35], ['work_orders', 204], ['work_order_work_types', 218], ['worker_work_competencies', 135]]) assert.equal(db.prepare(`SELECT COUNT(*) n FROM ${quote(table)}`).get().n, expected, table);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM work_orders WHERE status='new' AND assignee_worker_id IS NULL").get().n, 203);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM work_orders WHERE status='completed'").get().n, 1);
  for (const table of ['report_media', 'work_reports', 'route_plans', 'route_plan_groups', 'mobile_commands', 'mobile_session_bindings', 'mobile_issues']) assert.equal(db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n, 0, table);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  return { divisions: 3, brigades: 35, orders: 204, unassigned: 203, completed: 1, components: 218, competencies: 135 };
}

/** Offline atomic replacement. Only the CLI opens the fixed local database.
 * Unknown tables or real organization-bound AI connections fail closed.
 * Users and authentication remain byte-for-byte unchanged; no non-admin gains
 * access to new divisions. Existing demo memberships are removed with the data.
 */
export async function replaceDataset(db, { beforeCommit } = {}) {
  if (db.prepare('SELECT version FROM application_dataset WHERE id=1').get()) {
    assert.equal(db.prepare('SELECT version FROM application_dataset WHERE id=1').get().version, manifest.datasetVersion, 'Different dataset already installed');
    assert.equal(db.prepare('SELECT content_hash FROM dataset_imports WHERE version=?').get(manifest.datasetVersion)?.content_hash, manifest.contentHash);
    return { replaced: false, version: manifest.datasetVersion };
  }
  const known = await expectedTables(), names = tables(db);
  assert.ok(names.every(name => known.has(name)), 'Unknown tables require an explicit transition policy');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM ai_verifier_connections WHERE endpoint_url <> 'https://example.invalid/verify'").get().n, 0, 'Real AI connections require an explicit old/new division mapping');
  const admins = db.prepare("SELECT id FROM users WHERE role IN ('admin','administrator') AND status='active' ORDER BY id").all();
  assert.ok(admins.length, 'An active administrator must be preserved');
  const before = databaseInventory(db), pending = new Set(names.filter(n => !preserved.has(n))), order = [];
  const parents = new Map(names.map(n => [n, new Set(db.prepare(`PRAGMA foreign_key_list(${quote(n)})`).all().map(r => r.table))]));
  while (pending.size) {
    const next = [...pending].find(n => ![...pending].some(child => child !== n && parents.get(child).has(n)));
    assert.ok(next, 'Cyclic dependencies require an explicit transition policy');
    order.push(next); pending.delete(next);
  }
  db.exec('PRAGMA foreign_keys=ON; BEGIN IMMEDIATE');
  try {
    for (const name of order) db.exec(`DELETE FROM ${quote(name)}`);
    await importBeelineIntoEmptyDatabase(d1Adapter(db), admins[0].id);
    const now = new Date().toISOString();
    for (const division of manifest.divisions) {
      for (const admin of admins.slice(1)) db.prepare("INSERT INTO memberships (id,organization_id,user_id,role_id,status,created_at,updated_at) VALUES (?,?,?,?,'active',?,?)").run(`${division.id}:${admin.id}`, division.id, admin.id, `${division.id}:administrator`, now, now);
      db.prepare("INSERT INTO organization_planning_settings (organization_id,optimization_engine,travel_matrix_provider,solver_engine,solver_policy,updated_at) VALUES (?,'local_greedy','osrm','ortools','emergency_fast/v1',?)").run(division.id, now);
    }
    const counts = verifyDataset(db), after = databaseInventory(db);
    for (const name of ['users', 'sessions', 'auth_login_attempts']) assert.deepEqual(after[name], before[name], `Preserve ${name}`);
    assert.equal((await importBeelineIntoEmptyDatabase(d1Adapter(db), admins[0].id)).imported, false);
    if (beforeCommit) await beforeCommit();
    db.exec('COMMIT');
    return { replaced: true, version: manifest.datasetVersion, counts, removed: Object.fromEntries(order.map(n => [n, before[n].count])), retainedUsers: after.users.count, retainedAdmins: admins.length };
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

async function assertOffline() {
  const running = await new Promise(resolve => {
    const socket = createConnection({ host: '127.0.0.1', port: 3000 });
    socket.setTimeout(1000);
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', error => { socket.destroy(); resolve(error.code !== 'ECONNREFUSED'); });
    socket.once('timeout', () => { socket.destroy(); resolve(true); });
  });
  assert.equal(running, false, 'Stop the local application on port 3000 before transition');
}

async function fileInventory(folder) {
  const result = {};
  if (!await exists(folder)) return result;
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      assert.ok(!entry.isSymbolicLink(), 'Symlinks are not allowed in the local state backup');
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(file);
      else if (!entry.name.endsWith('-shm')) result[path.relative(folder, file)] = digest(await readFile(file));
    }
  }
  await walk(folder); return result;
}

async function main() {
  assert.ok(process.argv.slice(2).every(arg => arg === '--apply'), 'Only --apply is supported; the target is always project-local');
  await assertOffline();
  const sourceFolder = path.join(stateRoot, 'd1/miniflare-D1DatabaseObject');
  const candidates = (await readdir(sourceFolder)).filter(n => /^[a-f0-9]{64}\.sqlite$/.test(n));
  assert.equal(candidates.length, 1, 'Expected exactly one local application database');
  const sourcePath = path.join(sourceFolder, candidates[0]);
  assert.ok((await realpath(sourcePath)).startsWith((await realpath(stateRoot)) + path.sep));
  const output = path.join(outputRoot, `${new Date().toISOString().replaceAll(':', '-')}-${randomUUID()}`);
  const saved = path.join(output, 'backup'), restored = path.join(output, 'restored');
  await mkdir(saved, { recursive: true });
  const source = new DatabaseSync(sourcePath, { readOnly: true });
  let before;
  try {
    before = databaseInventory(source);
    assert.deepEqual(source.prepare('PRAGMA foreign_key_check').all(), []);
    await backup(source, path.join(saved, 'application.sqlite'));
  } finally { source.close(); }
  const stateFiles = await fileInventory(stateRoot);
  await cp(stateRoot, path.join(saved, 'state'), { recursive: true, errorOnExist: true, force: false });
  assert.deepEqual(await fileInventory(path.join(saved, 'state')), stateFiles);
  for (const file of ['.dev.vars', '.env', '.env.local', '.openai/hosting.json', 'vite.config.ts']) {
    if (!await exists(path.join(root, file))) continue;
    const target = path.join(saved, 'config', file); await mkdir(path.dirname(target), { recursive: true }); await cp(path.join(root, file), target, { errorOnExist: true, force: false });
  }
  await cp(saved, restored, { recursive: true, errorOnExist: true, force: false });
  assert.deepEqual(await fileInventory(restored), await fileInventory(saved));
  const restoredDb = new DatabaseSync(path.join(restored, 'application.sqlite'), { readOnly: true });
  try { assert.deepEqual(databaseInventory(restoredDb), before); assert.equal(restoredDb.prepare('PRAGMA integrity_check').get().integrity_check, 'ok'); } finally { restoredDb.close(); }
  const restoredStateDb = new DatabaseSync(path.join(restored, 'state', path.relative(stateRoot, sourcePath)), { readOnly: true });
  try { assert.deepEqual(databaseInventory(restoredStateDb), before); assert.deepEqual(restoredStateDb.prepare('PRAGMA foreign_key_check').all(), []); } finally { restoredStateDb.close(); }
  // The restored media metadata AND every blob are byte-identical. The actual
  // transition rehearsal starts from a separate restored database copy.
  await cp(path.join(saved, 'application.sqlite'), path.join(output, 'rehearsal.sqlite'), { errorOnExist: true, force: false });
  const rehearsal = new DatabaseSync(path.join(output, 'rehearsal.sqlite'));
  let result;
  try { await upgradeSchema(rehearsal); result = await replaceDataset(rehearsal); } finally { rehearsal.close(); }
  const report = { applied: false, restoreVerified: true, before, stateFiles: Object.keys(stateFiles).length, result, sourcePath, backup: saved, restored };
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  if (process.argv.includes('--apply') && result.replaced) {
    await assertOffline();
    assert.deepEqual(await fileInventory(stateRoot), stateFiles, 'Source changed during rehearsal; start again');
    // Move the exact verified local R2 state out of the active installation.
    // Keeping it in the private backup makes restoration possible; the new
    // application receives an empty R2 store. No remote bucket is contacted.
    const media = path.join(stateRoot, 'r2');
    let mediaMoved = false;
    const live = new DatabaseSync(sourcePath);
    try {
      assert.deepEqual(databaseInventory(live), before);
      await upgradeSchema(live);
      if (await exists(media)) {
        const resolved = await realpath(media);
        assert.equal(resolved, path.join(await realpath(stateRoot), 'r2'));
        await rename(resolved, path.join(output, 'retired-r2'));
        mediaMoved = true;
      }
      await replaceDataset(live);
    }
    catch (error) { if (mediaMoved) await rename(path.join(output, 'retired-r2'), media); throw error; }
    finally { live.close(); }
    report.applied = true;
    await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  }
  console.log(JSON.stringify({ report: path.join(output, 'report.json'), applied: report.applied, restoreVerified: true, result }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
