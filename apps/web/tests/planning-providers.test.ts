import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { evaluatePlan, ProviderError, type PlanningProblem, type TravelTimeMatrixPort } from "@mmi/provider-contracts";
import { OsrmAdapter } from "../app/lib/server/planning/osrm.js";
import { TwoGisOptimizationEngine } from "../app/lib/server/planning/two-gis-optimizer.js";
import { TwoGisMatrixAdapter } from "../app/lib/server/planning/two-gis-matrix.js";
import { selectPlanningProviders } from "../app/lib/server/planning/providers.js";
import { PyVrpOptimizationEngine } from "../app/lib/server/planning/pyvrp-optimizer.js";
import { realOptimizer } from "./helpers/real-optimizer.js";
import { isWorkerTransportSupported, workerTravelProfile } from "../app/lib/server/planning/worker-travel-policy.js";
import { OSRM_TRAVEL_WARNING, type PlanningSettings } from "../app/lib/planning-settings.js";
import { includeUnroutedEngineers } from "../app/dispatcher/unrouted-engineers.js";
import { appendPausedVisits } from "../app/dispatcher/paused-visits.js";
import type { Engineer } from "../app/dispatcher/data.js";

const a = { id: "a", point: { lat: 55.75, lon: 37.6 } };
const b = { id: "b", point: { lat: 55.76, lon: 37.62 } };
const config = { drivingUrl: "https://osrm.example", walkingUrl: "https://foot.example" };
const json = (data: unknown, status = 200) => Response.json(data, { status });
const rejectsCode = (code: string) => (error: unknown) => error instanceof ProviderError && error.code === code;

it("cycling uses a dedicated bike graph for both matrix and geometry and never falls back to a car graph",async()=>{
  const profile = { mode: "cycling", traffic: "disabled" } as const;
  await assert.rejects(new OsrmAdapter(config).calculate({origins:[a],destinations:[b],profile}),rejectsCode("NOT_SUPPORTED"));
  const calls:string[]=[];
  const adapter=new OsrmAdapter({...config,cyclingUrl:"https://bike.example"},async input=>{
    const url=new URL(String(input));calls.push(url.pathname);
    assert.equal(url.hostname,"bike.example");
    assert.match(url.pathname,/\/v1\/bike\//);
    return url.pathname.startsWith('/table/') ? json({code:"Ok",durations:[[120]],distances:[[350]]})
      : json({code:"Ok",routes:[{duration:120,distance:350,geometry:{type:"LineString",coordinates:[[37.6,55.75],[37.62,55.76]]},legs:[{duration:120,distance:350,steps:[]}]}]});
  });
  assert.equal((await adapter.calculate({origins:[a],destinations:[b],profile})).data.cells[0]!.status,"ok");
  assert.equal((await adapter.buildRoute({stops:[a,b],profile})).data[0]!.durationSeconds,120);
  assert.equal(calls.length,2);
});

describe("OSRM road adapters", () => {
  it("preserves directed matrices, units, zero distances and unreachable cells", async () => {
    const fetcher: typeof fetch = async (input) => {
      const url = new URL(String(input));
      assert.equal(url.pathname, "/table/v1/driving/37.6,55.75;37.62,55.76");
      assert.equal(url.searchParams.get("annotations"), "duration,distance");
      assert.equal(url.searchParams.has("fallback_speed"), false);
      return json({ code: "Ok", durations: [[0, 91.5], [null, 0]], distances: [[0, 1072.4], [null, 0]] });
    };
    const result = await new OsrmAdapter(config, fetcher).calculate({ origins: [a, b], destinations: [a, b], profile: { mode: "driving" } });
    assert.deepEqual(result.data.cells, [
      { status: "ok", originId: "a", destinationId: "a", durationSeconds: 0, distanceMeters: 0 },
      { status: "ok", originId: "a", destinationId: "b", durationSeconds: 91.5, distanceMeters: 1072.4 },
      { status: "no_route", originId: "b", destinationId: "a", reason: "OSRM: дорожный маршрут не найден" },
      { status: "ok", originId: "b", destinationId: "b", durationSeconds: 0, distanceMeters: 0 },
    ]);
  });

  it("chunks large rectangular matrices and restores row-major ordering", async () => {
    let calls = 0;
    const points = Array.from({ length: 85 }, (_, i) => ({ id: String(i), point: { lat: 55 + i / 100, lon: 37 } }));
    const fetcher: typeof fetch = async (input) => {
      calls++;
      const url = new URL(String(input));
      const sourceCount = url.searchParams.get("sources")!.split(";").length;
      const destCount = url.searchParams.get("destinations")!.split(";").length;
      assert.ok(url.pathname.split("/").at(-1)!.split(";").length <= 80);
      return json({ code: "Ok", durations: Array.from({ length: sourceCount }, () => Array(destCount).fill(60)), distances: Array.from({ length: sourceCount }, () => Array(destCount).fill(120)) });
    };
    const result = await new OsrmAdapter(config, fetcher).calculate({ origins: points.slice(0, 43), destinations: points.slice(43), profile: { mode: "driving" } });
    assert.equal(calls, 4);
    assert.equal(result.data.cells.length, 43 * 42);
    assert.equal(result.data.cells[41]?.destinationId, "84");
    assert.equal(result.data.cells[42]?.originId, "1");
  });

  it("reuses directed cells across brigades and only fetches new coordinates, keeping profiles separate", async () => {
    let calls = 0;
    const adapter = new OsrmAdapter(config, async input => {
      calls++;
      const url = new URL(String(input));
      const coords = url.pathname.split('/').at(-1)!.split(';').map(pair => Number(pair.split(',')[0]));
      const sources = url.searchParams.get('sources')!.split(';').map(Number);
      const destinations = url.searchParams.get('destinations')!.split(';').map(Number);
      const values = sources.map(s => destinations.map(d => coords[s] === 37.62 && coords[d] === 37.6 ? null : Math.round(coords[s]! * 100 + coords[d]! * 1000)));
      return json({code:'Ok',durations:values,distances:values});
    });
    const first = await adapter.calculate({origins:[a,b],destinations:[a,b],profile:{mode:'driving'}});
    const aliases = [a,b].map(item => ({...item,id:`other:${item.id}`}));
    const repeated = await adapter.calculate({origins:aliases,destinations:aliases,profile:{mode:'driving'}});
    assert.equal(calls,1);
    assert.deepEqual(repeated.data.cells,first.data.cells.map(cell => ({...cell,originId:`other:${cell.originId}`,destinationId:`other:${cell.destinationId}`})));
    const c = {id:'c',point:{lat:55.77,lon:37.63}};
    await adapter.calculate({origins:[a,b,c],destinations:[a,b,c],profile:{mode:'driving'}});
    assert.equal(calls,3); // Existing rows to c, then c to all points.
    await adapter.calculate({origins:[a,b],destinations:[a,b],profile:{mode:'walking'}});
    assert.equal(calls,4);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(adapter.calculate({origins:[a,b],destinations:[a,b],profile:{mode:'driving'}},{signal:controller.signal}),rejectsCode('CANCELLED'));
  });

  it("builds a common 66-address matrix once for 12 brigades from the same office", async () => {
    let calls = 0;
    const adapter = new OsrmAdapter(config, async input => {
      calls++;
      const url = new URL(String(input));
      const rows = url.searchParams.get('sources')!.split(';').length;
      const columns = url.searchParams.get('destinations')!.split(';').length;
      return json({code:'Ok',durations:Array.from({length:rows},()=>Array(columns).fill(60)),distances:Array.from({length:rows},()=>Array(columns).fill(100))});
    });
    const jobs = Array.from({length:66},(_,i)=>({id:`job:${i}`,point:{lat:55+i/1000,lon:37}}));
    for (let i=0;i<12;i++) {
      const points=[...jobs,{id:`office:${i}`,point:a.point}];
      const result=await adapter.calculate({origins:points,destinations:points,profile:{mode:'driving'}});
      assert.equal(result.data.cells.length,67*67);
      assert.equal(result.data.cells.at(-1)?.originId,`office:${i}`);
    }
    assert.equal(calls,4); // Previously 48 table requests.
  });

  it("uses the walking server and refuses to label driving times as public transport", async () => {
    let calls = 0;
    const adapter = new OsrmAdapter(config, async (input) => {
      calls++;
      assert.equal(new URL(String(input)).hostname, "foot.example");
      return json({ code: "Ok", durations: [[600]], distances: [[800]] });
    });
    await adapter.calculate({ origins: [a], destinations: [b], profile: { mode: "walking" } });
    await assert.rejects(adapter.calculate({ origins: [a], destinations: [b], profile: { mode: "public_transport" } }), rejectsCode("NOT_SUPPORTED"));
    assert.equal(calls, 1);
  });

  it("returns full road geometry with one leg per stop pair", async () => {
    const shape = { type: "LineString", coordinates: [[37.6, 55.75], [37.61, 55.751], [37.62, 55.76]] };
    const adapter = new OsrmAdapter(config, async (input) => {
      const url = new URL(String(input));
      assert.equal(url.searchParams.get("overview"), "full");
      assert.equal(url.searchParams.get("continue_straight"), "false");
      return json({ code: "Ok", routes: [{ geometry: shape, legs: [{ duration: 100, distance: 900, steps: [{ geometry: shape }] }] }] });
    });
    const result = await adapter.buildRoute({ stops: [a, b], profile: { mode: "driving" } });
    assert.deepEqual(result.data[0]?.geometry[1], { lon: 37.61, lat: 55.751 });
    assert.equal(result.data[0]?.legs[0]?.toStopId, "b");
    assert.equal(result.data[0]?.distanceMeters, 900);
  });

  it("rejects missing metrics and straight-line fallbacks", async () => {
    for (const payload of [
      { code: "Ok", durations: [[2]], distances: [] },
      { code: "Ok", durations: [[2]], distances: [[-1]] },
      { code: "Ok", durations: [[2]], distances: [[1]], fallback_speed_cells: [[0, 0]] },
    ]) {
      const adapter = new OsrmAdapter(config, async () => json(payload));
      await assert.rejects(adapter.calculate({ origins: [a], destinations: [b], profile: { mode: "driving" } }), rejectsCode("BAD_RESPONSE"));
    }
  });

  it("surfaces HTTP limits and cancellation, without another provider or estimated data", async () => {
    const adapter = new OsrmAdapter(config, async () => json({}, 429));
    await assert.rejects(adapter.calculate({ origins: [a], destinations: [b], profile: { mode: "driving" } }), rejectsCode("RATE_LIMITED"));
    const controller = new AbortController();
    controller.abort();
    const cancelled = new OsrmAdapter(config, async (_input, init) => { init?.signal?.throwIfAborted(); return json({}); });
    await assert.rejects(cancelled.calculate({ origins: [a], destinations: [b], profile: { mode: "driving" } }, { signal: controller.signal }), rejectsCode("CANCELLED"));
  });
});

const problem: PlanningProblem = {
  id: "test-planning", horizon: { startAt: "2026-09-08T08:00:00Z", endAt: "2026-09-08T17:00:00Z" },
  profile: { mode: "driving", traffic: "disabled" }, resources: [], objectives: [{ kind: "minimize_travel_time", weight: 1 }],
  agents: [{ id: "worker", skills: ["electrician"], fixedResourceTags: [], shifts: [{ id: "shift", window: { startAt: "2026-09-08T08:00:00Z", endAt: "2026-09-08T17:00:00Z" }, startLocation: a.point, endLocation: a.point, breaks: [{ startAt: "2026-09-08T12:00:00Z", endAt: "2026-09-08T13:00:00Z" }] }] }],
  jobs: [0, 1].map((index) => ({ id: `job-${index}`, location: b.point, serviceDurationSeconds: 3600, state: "new", changePolicy: "free", hardTimeWindows: [{ startAt: "2026-09-08T08:00:00Z", endAt: "2026-09-08T17:00:00Z" }], softTimeWindows: [{ startAt: "2026-09-08T11:30:00Z", endAt: "2026-09-08T11:30:00Z", penaltyPerMinute: 1 }], requiredSkills: ["electrician"] })),
};
const matrix: TravelTimeMatrixPort = {
  providerId: "2gis",
  async calculate(request) { return { data: {
    originIds: request.origins.map((point) => point.id), destinationIds: request.destinations.map((point) => point.id),
    cells: request.origins.flatMap((origin) => request.destinations.map((destination) => ({ status: "ok", originId: origin.id, destinationId: destination.id, durationSeconds: 60, distanceMeters: 200 }))),
  }, meta: { providerId: "2gis", receivedAt: new Date().toISOString(), cache: "bypass" } }; },
};

describe("planner selection and TSP integration", () => {
  it("keeps more than ten candidate jobs for one worker using the chunked 2GIS matrix", async () => {
    let calls = 0;
    const adapter = new TwoGisMatrixAdapter("test-key", async (_url, init) => {
      calls++;
      const body = JSON.parse(String(init?.body)) as { sources: number[]; targets: number[] };
      assert.ok(body.sources.length <= 10 && body.targets.length <= 10);
      return json({ routes: body.sources.flatMap((source) => body.targets.map((target) => ({ source_id: source, target_id: target, status: "OK", duration: 60, distance: 200 }))) });
    });
    const manyJobs: PlanningProblem = { ...problem, jobs: Array.from({ length: 12 }, (_, index) => ({
      ...problem.jobs[0]!, id: `job-${index}`, serviceDurationSeconds: 60, softTimeWindows: [],
    })) };
    const result = await new PyVrpOptimizationEngine(adapter, {url:"http://localhost:8765"}, realOptimizer).optimize(manyJobs);
    assert.equal(calls, 4); // 12 jobs + start and return: 14 × 14, not truncated to 10 stops.
    assert.equal(result.unassigned.length, 0);
    assert.equal(new Set(result.routes[0]?.visits.map((visit) => visit.jobId)).size, 12);
    assert.equal(evaluatePlan(manyJobs, result).validation.valid, true);
  });

  it("selects actual independent adapters and rejects an unsupported combination", () => {
    const selected = selectPlanningProviders({ optimizationEngine: "pyvrp", travelMatrixProvider: "osrm" }, "");
    assert.equal(selected.matrix.providerId, "osrm");
    assert.equal(selected.routing.providerId, "osrm");
    assert.ok(selected.optimizer instanceof PyVrpOptimizationEngine);
    assert.ok(selectPlanningProviders({ optimizationEngine: "two_gis_tsp", travelMatrixProvider: "two_gis" }, "test").optimizer instanceof TwoGisOptimizationEngine);
    assert.throws(() => selectPlanningProviders({ optimizationEngine: "two_gis_tsp", travelMatrixProvider: "osrm" }, "test"), rejectsCode("NOT_SUPPORTED"));
  });

  it("polls TSP, keeps the external order, enforces breaks and exposes draft changes", async () => {
    let calls = 0;
    const fetcher: typeof fetch = async (input, init) => {
      calls++;
      if (calls === 1) {
        const body = JSON.parse(String(init?.body));
        assert.deepEqual(body.waypoints[0].required_tags, ["electrician"]);
        assert.equal(body.waypoints[0].service_duration_s, 3600);
        assert.equal(body.agents[0].finish_at, "start-agent-0");
        assert.deepEqual(body.waypoints[0].depot_ids, ["start-agent-0"]);
        return json({ task_id: "task", status: { status: "Run" } });
      }
      assert.equal(new URL(String(input)).searchParams.get("task_id"), "task");
      return json({ status: { status: "Done" }, result: { routes: [{ agent_id: "agent-0", route: [
        { node: { type: "depot", value: { depot_id: "start-agent-0" } } },
        { node: { type: "delivery", value: { waypoint_id: "job-1" } } },
        { node: { type: "delivery", value: { waypoint_id: "job-0" } } },
        { node: { type: "depot", value: { depot_id: "end-agent-0" } } },
      ] }] } });
    };
    const result = await new TwoGisOptimizationEngine("test", matrix, fetcher, 0).optimize(problem);
    assert.deepEqual(result.routes[0]?.visits.map((visit) => visit.jobId), ["job-1", "job-0"]);
    assert.equal(result.routes[0]?.visits[0]?.serviceStartAt, "2026-09-08T13:00:00.000Z");
    assert.equal(result.changes.length, 2);
    assert.equal(evaluatePlan(problem, result).validation.valid, true);
    assert.equal(calls, 2);
  });

  it("does not silently use the local optimizer or retry creation if TSP access is denied", async () => {
    let calls = 0;
    await assert.rejects(new TwoGisOptimizationEngine("test", matrix, async () => { calls++; return json({}, 403); }).optimize(problem), rejectsCode("FORBIDDEN"));
    assert.equal(calls, 1);
  });

  it("does not use a driving TSP profile for a heterogeneous fleet", async () => {
    const mixed: PlanningProblem = { ...problem, agents: [...problem.agents, { ...problem.agents[0]!, id: "walker", travelProfile: { mode: "walking" } }] };
    await assert.rejects(new TwoGisOptimizationEngine("test", matrix, async () => { throw new Error("must not call"); }).optimize(mixed), rejectsCode("NOT_SUPPORTED"));
  });
});

describe("OSRM approximates public transport using driving roads", () => {
  const settings: PlanningSettings = { optimizationEngine: "pyvrp", travelMatrixProvider: "osrm" };

  it("keeps car, public-transport and no-transport workers eligible without changing their transport settings", () => {
    for (const mode of ["car", "transit"] as const) {
      assert.equal(isWorkerTransportSupported(mode, settings), true);
      assert.deepEqual(workerTravelProfile(mode, settings), { mode: "driving", traffic: "disabled" });
    }
    assert.ok(selectPlanningProviders(settings, "").warnings.includes(OSRM_TRAVEL_WARNING));
    assert.match(OSRM_TRAVEL_WARNING, /по автомобильным дорогам/u);
    assert.doesNotMatch(OSRM_TRAVEL_WARNING, /Не участвуют|не поддерживается/u);
  });

  it("preserves native 2GIS profiles and the independent TSP restriction", () => {
    const twoGis = { ...settings, travelMatrixProvider: "two_gis" as const };
    assert.equal(isWorkerTransportSupported("transit", twoGis), true);
    assert.deepEqual(workerTravelProfile("transit", twoGis), { mode: "public_transport", traffic: "forecast" });
    assert.deepEqual(workerTravelProfile("car", twoGis), { mode: "driving", traffic: "forecast" });
    assert.equal(isWorkerTransportSupported("transit", { ...twoGis, optimizationEngine: "two_gis_tsp" }), false);
  });

  it("calculates a mixed fleet with real adapter profiles, including the only qualified transit worker", async () => {
    const modes = ["car", "transit"] as const;
    const workers = modes.map((mode) => ({ id: mode, transportMode: mode }));
    const before = JSON.stringify(workers);
    const profilesRequested = new Set<string>();
    const adapter = new OsrmAdapter(config, async (input) => {
      const url = new URL(String(input));
      const walking = url.hostname === "foot.example";
      assert.equal(url.pathname.includes("/foot/"), walking);
      profilesRequested.add(walking ? "walking" : "driving");
      const duration = walking ? 600 : 60;
      if (url.pathname.includes("/table/")) {
        const rows = url.searchParams.get("sources")!.split(";").length;
        const columns = url.searchParams.get("destinations")!.split(";").length;
        return json({ code: "Ok", durations: Array.from({ length: rows }, () => Array(columns).fill(duration)), distances: Array.from({ length: rows }, () => Array(columns).fill(700)) });
      }
      const coordinates = url.pathname.split("/").at(-1)!.split(";").map((pair) => pair.split(",").map(Number));
      return json({ code: "Ok", routes: [{ geometry: { type: "LineString", coordinates }, legs: coordinates.slice(1).map((point, index) => ({
        duration, distance: 700, steps: [{ geometry: { type: "LineString", coordinates: [coordinates[index], point] } }],
      })) }] });
    });
    const mixed: PlanningProblem = {
      ...problem,
      agents: workers.filter((worker) => isWorkerTransportSupported(worker.transportMode, settings)).map((worker) => ({
        ...problem.agents[0]!, id: worker.id, skills: [worker.id], travelProfile: workerTravelProfile(worker.transportMode, settings),
      })),
      jobs: modes.map((mode) => ({ ...problem.jobs[0]!, id: `job-${mode}`, requiredSkills: [mode], softTimeWindows: [] })),
    };
    const result = await new PyVrpOptimizationEngine(adapter, {url:"http://localhost:8765"}, realOptimizer).optimize(mixed);
    assert.equal(result.routes.length, 2);
    assert.equal(result.unassigned.length, 0);
    assert.equal(evaluatePlan(mixed, result).validation.valid, true);
    for (const route of result.routes) {
      assert.equal(route.visits[0]!.jobId, `job-${route.agentId}`);
      const profile = mixed.agents.find((agent) => agent.id === route.agentId)!.travelProfile!;
      const geometry = await adapter.buildRoute({ stops: [a, b, { ...a, id: "end" }], profile });
      assert.equal(geometry.data[0]!.legs.length, 2);
      assert.equal(geometry.data[0]!.durationSeconds, route.totalTravelSeconds);
      assert.equal(route.totalTravelSeconds, 120);
    }
    assert.deepEqual([...profilesRequested].sort(), ["driving"]);
    assert.equal(JSON.stringify(workers), before);
  });

  it("retains unrouted personnel in the panel without restoring old assignments or duplicating paused work", () => {
    const cards: Engineer[] = [{ id: "CAR", initials: "АИ", name: "Алексей", vehicle: "Автомобиль", load: 20, accent: "gold", visits: [{ requestId: "NEW", time: "09:00", label: "Новая" }] }];
    const workers = [
      { id: "CAR", name: "Алексей", vehicle: "Автомобиль", load: 20 },
      { id: "TRANSIT", name: "Мария", vehicle: "Метро", load: 75 },
      { id: "NONE", name: "Илья", vehicle: "Без транспорта", load: 40 },
    ];
    const visible = includeUnroutedEngineers(cards, workers);
    assert.deepEqual(visible.map((card) => card.id), ["CAR", "TRANSIT", "NONE"]);
    assert.equal(visible[0], cards[0]);
    assert.equal(visible[1]!.load, 0);
    assert.deepEqual(visible[1]!.visits, []);
    assert.equal(visible[2]!.vehicle, "Без транспорта");
    const withPaused = appendPausedVisits(visible, [{ id: "PAUSED", status: "paused", dateTime: "2026-09-07T10:00", assignee: "Мария", assigneeId: "TRANSIT" }], workers);
    assert.equal(withPaused.length, 3);
    assert.equal(withPaused[1]!.visits.length, 1);
    assert.equal(withPaused[1]!.visits[0]!.paused, true);
    assert.equal(cards.length, 1);
  });
});
