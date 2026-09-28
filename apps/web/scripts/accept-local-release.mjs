import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { manifest } from './lib/beeline-import.mjs';

// Local release acceptance only. Credentials and cookies never enter output.
const origin = 'http://127.0.0.1:3000';
const vars = Object.fromEntries((await readFile(new URL('../.dev.vars', import.meta.url), 'utf8')).split(/\r?\n/).flatMap(line => {
  const match = /^\s*([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line);
  if (!match) return [];
  let value = match[2].trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
  return [[match[1], value]];
}));
assert.ok(vars.AUTH_BOOTSTRAP_EMAIL && vars.AUTH_BOOTSTRAP_PASSWORD, 'Local bootstrap login is required');
let cookie = '';
async function api(path, method = 'GET', body) {
  const response = await fetch(`${origin}${path}`, { method, headers: { origin, cookie, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(360_000) });
  if (path === '/api/auth/login' && response.ok) cookie = response.headers.get('set-cookie').split(';')[0];
  const data = await response.json();
  assert.ok(response.ok, `${method} ${path}: HTTP ${response.status} ${data.message ?? data.error ?? ''}`);
  return data;
}
await api('/api/auth/login', 'POST', { email: vars.AUTH_BOOTSTRAP_EMAIL, password: vars.AUTH_BOOTSTRAP_PASSWORD });
const workspace = await api('/api/planning/workspace');
assert.equal(workspace.departments.length, 3); assert.equal(workspace.engineers.length, 35); assert.equal(workspace.items.length, 204);
console.log('Local login, dataset and all three divisions verified.');
let result = (await api(`/api/planning/group?date=${manifest.serviceDate}`)).result;
if (process.argv.includes('--publish') && !result) {
  result = (await api('/api/planning/group', 'POST', { serviceDate: manifest.serviceDate })).result;
  console.log('Common draft calculated:', JSON.stringify(result.metrics));
}
assert.ok(result, 'No plan exists; use --publish for the initial authorized calculation');
assert.equal(result.metrics.totalJobs, 203); assert.equal(result.metrics.hardViolations, 0);
assert.equal(result.departments.length, 3);
assert.ok(result.optimizerId.includes('ortools'), 'Expected OR-Tools');
assert.equal(result.providerId, 'osrm');
if (process.argv.includes('--publish') && result.status !== 'published') {
  await api('/api/planning/group', 'PUT', { planId: result.planId });
  result = (await api(`/api/planning/group?date=${manifest.serviceDate}`)).result;
}
assert.equal(result.status, 'published');
const after = await api('/api/planning/workspace');
assert.equal(after.items.length, 204); assert.equal(after.engineers.length, 35);
const output = new URL('../.tmp/local-release/', import.meta.url); await mkdir(output, { recursive: true });
const report = { checkedAt: new Date().toISOString(), serviceDate: manifest.serviceDate, datasetVersion: manifest.datasetVersion,
  departments: workspace.departments.map(d => ({ id: d.id, name: d.name })), brigades: 35, orders: 204, planId: result.planId,
  status: result.status, optimizer: result.optimizerId, provider: result.providerId, metrics: result.metrics, warnings: result.warnings,
  routes: result.routes.map(r => ({ workerId: r.agentId, visits: r.visits.length, distanceKm: r.totalDistanceKm, geometrySource: r.geometrySource })),
  unassigned: result.unassigned, changes: result.changes.length };
await writeFile(new URL('acceptance.json', output), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ serviceDate: report.serviceDate, status: report.status, metrics: report.metrics, warnings: report.warnings, report: 'apps/web/.tmp/local-release/acceptance.json' }, null, 2));
