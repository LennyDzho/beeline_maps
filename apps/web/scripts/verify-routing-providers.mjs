import { readFile } from "node:fs/promises";
import { OsrmAdapter } from "../.tmp/test-build/apps/web/app/lib/server/planning/osrm.js";
import { TwoGisOptimizationEngine } from "../.tmp/test-build/apps/web/app/lib/server/planning/two-gis-optimizer.js";
import { TwoGisMatrixAdapter } from "../.tmp/test-build/apps/web/app/lib/server/planning/two-gis-matrix.js";
import { evaluatePlan } from "@mmi/provider-contracts";

const source = await readFile(new URL("../.dev.vars", import.meta.url), "utf8");
const vars = Object.fromEntries(source.split(/\r?\n/).flatMap((line) => {
  const match = /^([A-Z_]+)=(.*)$/.exec(line.trim());
  return match ? [[match[1], match[2].replace(/^["']|["']$/g, "")]] : [];
}));
const stops = [
  { id: "start", point: { lat: 55.764332, lon: 37.605765 } },
  { id: "visit", point: { lat: 55.78646, lon: 37.57079 } },
];
let failures = 0;
if (!process.argv.includes("--tsp-only")) {
  const osrm = new OsrmAdapter({ drivingUrl: vars.OSRM_BASE_URL, walkingUrl: vars.OSRM_WALKING_BASE_URL });
  for (const mode of ["driving", "walking"]) {
    try {
      const matrix = await osrm.calculate({ origins: stops, destinations: stops, profile: { mode } }, { timeoutMs: 20000 });
      const route = await osrm.buildRoute({ stops, profile: { mode } }, { timeoutMs: 20000 });
      const cell = matrix.data.cells[1];
      if (cell.status !== "ok" || route.data[0].geometry.length < 3) throw new Error("No road result");
      console.log(`OSRM ${mode}: ${cell.distanceMeters} m, ${cell.durationSeconds} s; geometry ${route.data[0].geometry.length} points.`);
    } catch (error) { failures++; console.error(`OSRM ${mode}: ${error.message}`); }
  }
}
if (process.argv.includes("--tsp") || process.argv.includes("--tsp-only")) {
  try {
    if (!vars.TWO_GIS_API_KEY) throw new Error("TWO_GIS_API_KEY is missing");
    const date = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    const window = { startAt: `${date}T08:00:00+03:00`, endAt: `${date}T17:00:00+03:00` };
    const problem = {
      id: "provider-connection-check", horizon: window, profile: { mode: "driving", traffic: "disabled" }, resources: [], objectives: [],
      agents: [{ id: "test-agent", skills: ["test-skill"], fixedResourceTags: [], shifts: [{ id: "test-shift", window, startLocation: stops[0].point, endLocation: stops[0].point }] }],
      jobs: [{ id: "test-job", location: stops[1].point, serviceDurationSeconds: 600, state: "new", changePolicy: "free", hardTimeWindows: [window], requiredSkills: ["test-skill"] }],
    };
    const diagnosticFetch = async (input, init) => {
      const response = await fetch(input, init);
      const payload = await response.clone().json().catch(() => ({}));
      if (process.argv.includes("--verbose")) console.log("TSP response:", JSON.stringify({ http: response.status, taskId: payload.task_id, status: payload.status, droppedWaypoints: payload.result?.dropped_waypoints, droppedAgents: payload.result?.dropped_agents }));
      return response;
    };
    const result = await new TwoGisOptimizationEngine(vars.TWO_GIS_API_KEY, new TwoGisMatrixAdapter(vars.TWO_GIS_API_KEY), diagnosticFetch).optimize(problem, { timeoutMs: 45000 });
    const evaluation = evaluatePlan(problem, result);
    if (!evaluation.validation.valid || result.routes.length !== 1) throw new Error("TSP did not return a valid assigned route");
    console.log(`2GIS TSP: valid route, ${result.routes[0].totalDistanceMeters} m.`);
  } catch (error) { failures++; console.error(`2GIS TSP: ${error.message}`); }
}
process.exitCode = failures ? 1 : 0;
