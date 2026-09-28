import assert from "node:assert/strict";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { isolatedWorker } from "./helpers/isolated-worker.mjs";
import { manifest, importBeelineIntoEmptyDatabase } from "./helpers/beeline-import.mjs";

// One application acceptance run against existing frozen roads. No geocoding,
// network, benchmark campaign, live database or research result modification.
const frozen = JSON.parse(await readFile(new URL("../../../algorithm-research/benchmark/datasets/problem.json", import.meta.url), "utf8"));
const python = process.env.OPTIMIZER_TEST_PYTHON ?? fileURLToPath(new URL(process.platform === "win32" ? "../../../algorithm-research/benchmark/.venv/Scripts/python.exe" : "../../../algorithm-research/benchmark/.venv/bin/python", import.meta.url));
const engine = process.env.OPTIMIZER_ACCEPTANCE_ENGINE ?? "ortools";
assert.ok(["ortools", "pyvrp"].includes(engine));
const solver = fileURLToPath(new URL("../../../services/optimizer/solver.py", import.meta.url));
const pointKey = p => `${p.lon},${p.lat}`;
const locations = new Map();
for (const [id, point] of [...frozen.jobs.map(j => [j.locationId, j.coordinates]), ...frozen.workers.map(w => [w.startLocationId, w.startCoordinates])]) {
  const key = pointKey(point);
  locations.set(key, [...new Set([...(locations.get(key) ?? []), id])]);
}
function arc(from, to) {
  for (const a of locations.get(from) ?? []) for (const b of locations.get(to) ?? []) {
    const duration = frozen.travelTimeMatrices.car[a]?.[b], distance = frozen.distanceMatrices.car[a]?.[b];
    if (duration !== undefined && distance !== undefined) return { duration, distance };
  }
  throw new Error(`No frozen road arc: ${from} → ${to}`);
}

test("SOLVER-04 all 203 imported jobs pass the application solver, validator and publication with frozen road matrices", { timeout: 180000 }, async t => {
  const app = await isolatedWorker({ prepareDatabase: async (database, db, administratorId) => {
    // At this point only legacy empty organization shells and the QA user exist.
    assert.equal(db.prepare("SELECT COUNT(*) n FROM work_orders").get().n, 0);
    db.exec("DELETE FROM organizations");
    await importBeelineIntoEmptyDatabase(database, administratorId);
  } });
  t.after(() => app.close());
  const results = [];
  app.solverHandler = input => Response.json(JSON.parse(execFileSync(python, [solver], {
    input: JSON.stringify(input), encoding: "utf8", timeout: 75000, windowsHide: true,
  })));
  app.osrmHandler = url => {
    if (url.pathname.startsWith("/route/")) return Response.json({ code: "NoRoute" }, { status: 400 }); // No geometry fixture.
    assert.ok(url.pathname.startsWith("/table/"));
    const points = url.pathname.split("/").at(-1).split(";");
    const indices = key => url.searchParams.get(key).split(";").map(Number);
    const cells = indices("sources").map(a => indices("destinations").map(b => arc(points[a], points[b])));
    return Response.json({ code: "Ok", durations: cells.map(row => row.map(c => c.duration)), distances: cells.map(row => row.map(c => c.distance)) });
  };
  const auth = app.cookie;
  for (const division of manifest.divisions) {
    app.cookie = `${auth}; mmi_organization=${encodeURIComponent(division.id)}`;
    await app.json("/api/admin/settings", { method: "PUT", body: { appName: "Марш!", timezone: division.timezone, emailAlerts: true, weeklyDigest: false,
      optimizationEngine: engine, travelMatrixProvider: "osrm", optimizerPolicy: "emergency_fast/v1" } });
  }
  const common=(await app.json("/api/planning/group", { method: "POST", body: { serviceDate: manifest.serviceDate } }, 201)).result;
  assert.equal(common.departments.length,3);assert.equal(common.metrics.plannedJobs,203);
  assert.equal(app.db.prepare("SELECT COUNT(*) n FROM work_orders WHERE status='assigned'").get().n,0);
  for (const division of manifest.divisions) {
    app.cookie = `${auth}; mmi_organization=${encodeURIComponent(division.id)}`;
    const { result } = await app.json(`/api/planning?date=${manifest.serviceDate}`);
    const jobs = manifest.jobs.filter(j => j.divisionId === division.id && j.status === "new");
    assert.equal(result.metrics.totalJobs, jobs.length);
    assert.equal(result.metrics.hardViolations, 0);
    assert.equal(result.changes.length, 0, "first assignments stay silent");
    for (const route of result.routes) {
      const worker = manifest.workers.find(w => w.id === route.agentId);
      assert.equal(worker.divisionId, division.id);
      let previousPoint = route.startPoint, previousEnd = Date.parse(route.shiftStartAt), distance = 0;
      for (const visit of route.visits) {
        const number = app.db.prepare('SELECT number FROM work_orders WHERE id=?').get(visit.jobId)?.number;
        const job = jobs.find(j => j.number === number);
        assert.ok(job);
        assert.ok(job.workTypeIds.every(id => worker.competencies.some(c => c.categoryId === job.categoryId && c.workTypeId === id)), "every HD is required");
        const road = arc(pointKey(previousPoint), pointKey(visit.point));
        const start = Date.parse(visit.serviceStartAt), end = Date.parse(visit.serviceEndAt);
        assert.ok(Date.parse(visit.arrivalAt) >= previousEnd + Math.ceil(road.duration) * 1000);
        assert.ok(start >= Date.parse(visit.arrivalAt));
        assert.ok(start >= Date.parse(`${job.clientWindowStart}+03:00`) && start <= Date.parse(`${job.clientWindowEnd}+03:00`));
        assert.equal(end - start, job.serviceDurationMinutes * 60000);
        assert.ok(end <= Date.parse(route.shiftEndAt));
        previousPoint = visit.point; previousEnd = end; distance += Math.ceil(road.distance);
      }
      assert.ok(Math.abs(route.totalDistanceKm - distance / 1000) <= .051);
      assert.equal(route.returnAt, null);
    }
    assert.equal(result.metrics.plannedJobs, jobs.length, "15-second application budget covers this prepared queue");
    results.push({ division: division.name, metrics: result.metrics, optimizerId: result.optimizerId });
    t.diagnostic(`${division.name}: ${result.metrics.plannedJobs}/${jobs.length}, ${result.metrics.engineersUsed} исполнителей, ${result.metrics.totalDistanceKm} км`);
  }
  await app.json("/api/planning/group", {method:"PUT",body:{planId:common.planId}});
  assert.equal((await app.json(`/api/planning/group?date=${manifest.serviceDate}`)).result.status,"published");
  assert.equal(app.db.prepare("SELECT COUNT(*) n FROM work_orders WHERE status='assigned'").get().n, 203);
  assert.equal(app.db.prepare("SELECT COUNT(*) n FROM work_orders WHERE status='completed'").get().n, 1);
  assert.deepEqual(app.db.prepare("PRAGMA foreign_key_check").all(), []);
  const directory = new URL("../.tmp/", import.meta.url);
  await mkdir(directory, { recursive: true });
  await writeFile(new URL(`${engine}-planning-acceptance.json`, directory), JSON.stringify({ at: new Date().toISOString(), datasetVersion: manifest.datasetVersion,
    matrixVersion: frozen.matrixVersion, matrixProvenance: frozen.matrixProvenance, geometryChecked: false, commonPlanId:common.planId, commonMetrics:common.metrics, results }, null, 2));
});
