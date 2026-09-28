import assert from 'node:assert/strict';
import test from 'node:test';
import { isolatedWorker } from './helpers/isolated-worker.mjs';
import { databaseInventory } from '../scripts/migrate-paused-local.mjs';
import { replaceDataset, verifyDataset } from '../scripts/local-dataset-transition.mjs';
import { manifest } from './helpers/beeline-import.mjs';

test('TRANSITION-01 replacement rolls back failures, preserves authentication, rejects unknown data and keeps re-runs harmless', async t => {
  const app = await isolatedWorker(); t.after(() => app.close());
  const before = databaseInventory(app.db);
  await assert.rejects(replaceDataset(app.db, { beforeCommit() { throw new Error('Injected late failure'); } }), /Injected late failure/);
  assert.deepEqual(databaseInventory(app.db), before, 'Late failure must restore every old row, including media and sessions');
  app.db.exec('CREATE TABLE unexpected_business_data (id TEXT)');
  await assert.rejects(replaceDataset(app.db), /Unknown tables/);
  app.db.exec('DROP TABLE unexpected_business_data');
  app.db.exec("UPDATE ai_verifier_connections SET endpoint_url='https://real.example.test/verify'");
  await assert.rejects(replaceDataset(app.db), /Real AI connections/);
  app.db.exec("UPDATE ai_verifier_connections SET endpoint_url='https://example.invalid/verify'");
  assert.deepEqual(databaseInventory(app.db), before);
  const result = await replaceDataset(app.db);
  assert.equal(result.replaced, true); verifyDataset(app.db);
  const after = databaseInventory(app.db);
  for (const table of ['users', 'sessions', 'auth_login_attempts']) assert.deepEqual(after[table], before[table]);
  const cookie = app.cookie;
  let accessible = 0;
  for (const division of manifest.divisions) {
    app.cookie = `${cookie}; mmi_organization=${encodeURIComponent(division.id)}`;
    accessible += (await app.json('/api/requests')).items.length;
  }
  assert.equal(accessible, 204, 'Existing administrator session keeps access to all replacement divisions');
  app.db.exec("UPDATE work_orders SET description='Dispatcher edit' WHERE id=(SELECT id FROM work_orders LIMIT 1)");
  const edited = databaseInventory(app.db);
  assert.equal((await replaceDataset(app.db)).replaced, false);
  assert.deepEqual(databaseInventory(app.db), edited, 'Retry must not reset dispatcher changes');
});
