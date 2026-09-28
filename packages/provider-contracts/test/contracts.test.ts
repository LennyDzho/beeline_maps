import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ProviderError,
  TWO_GIS_CAPABILITIES,
  assertGeoPoint,
  assertProviderBundle,
  comparePlanScores,
  evaluatePlan,
  getMatrixCell,
  scorePlan,
  validatePlan,
  type GeocodingCandidate,
  type PlanProposal,
  type PlanningProblem,
} from "../src/index.js";
import {
  HaversineMatrixProvider,
  InMemoryGeocoder,
  RecordingMapRenderer,
  StraightLineRouteProvider,
  createFakeProviderBundle,
} from "../src/testing/fakes.js";

const moscow = { lat: 55.7558, lon: 37.6176 };
const kazan = { lat: 55.7961, lon: 49.1064 };

describe("provider-neutral primitives", () => {
  it("uses explicit latitude and longitude fields", () => {
    assert.doesNotThrow(() => assertGeoPoint(moscow));
    assert.throws(() => assertGeoPoint({ lat: 181, lon: 55 }), RangeError);
  });

  it("rejects inconsistent provider bundles", () => {
    const bundle = createFakeProviderBundle();
    assert.doesNotThrow(() => assertProviderBundle(bundle));
    assert.throws(
      () =>
        assertProviderBundle({
          providerId: "wrong-id",
          capabilities: bundle.capabilities,
        }),
      /must match/,
    );
  });
});

describe("fake provider adapters", () => {
  const candidate: GeocodingCandidate = {
    point: moscow,
    formattedAddress: "Москва, Красная площадь, 1",
    components: {
      country: "Россия",
      locality: "Москва",
      street: "Красная площадь",
      house: "1",
    },
    precision: "building",
    confidence: 1,
  };

  it("normalizes forward geocoding queries", async () => {
    const geocoder = new InMemoryGeocoder([
      { query: "Москва, Красная площадь, 1", candidate },
    ]);
    const result = await geocoder.forward({ query: "  МОСКВА,   Красная площадь" });

    assert.equal(result.data.length, 1);
    assert.deepEqual(result.data[0]?.point, moscow);
    assert.equal(result.meta.providerId, "fake");
  });

  it("returns a complete, id-addressable matrix", async () => {
    const matrix = new HaversineMatrixProvider();
    const result = await matrix.calculate({
      origins: [
        { id: "moscow", point: moscow },
        { id: "kazan", point: kazan },
      ],
      destinations: [
        { id: "moscow", point: moscow },
        { id: "kazan", point: kazan },
      ],
      profile: { mode: "driving", traffic: "disabled" },
    });

    assert.equal(result.data.cells.length, 4);
    const self = getMatrixCell(result.data, "moscow", "moscow");
    const trip = getMatrixCell(result.data, "moscow", "kazan");
    assert.equal(self?.status, "ok");
    assert.equal(self?.status === "ok" ? self.distanceMeters : -1, 0);
    assert.equal(trip?.status, "ok");
    assert.ok(trip?.status === "ok" && trip.durationSeconds > 0);
  });

  it("normalizes route geometry to GeoPoint objects", async () => {
    const router = new StraightLineRouteProvider();
    const result = await router.buildRoute({
      stops: [
        { id: "moscow", point: moscow },
        { id: "kazan", point: kazan },
      ],
      profile: { mode: "driving" },
    });

    assert.deepEqual(result.data[0]?.geometry, [moscow, kazan]);
    assert.equal(result.data[0]?.legs[0]?.fromStopId, "moscow");
  });

  it("normalizes cancellation as ProviderError", async () => {
    const controller = new AbortController();
    controller.abort("test");
    const matrix = new HaversineMatrixProvider();

    await assert.rejects(
      matrix.calculate(
        {
          origins: [{ id: "a", point: moscow }],
          destinations: [{ id: "b", point: kazan }],
          profile: { mode: "driving" },
        },
        { signal: controller.signal },
      ),
      (error: unknown) => error instanceof ProviderError && error.code === "CANCELLED",
    );
  });

  it("keeps map rendering declarative", async () => {
    const renderer = new RecordingMapRenderer();
    await renderer.mount({} as Element, { markers: [], polylines: [] });
    await renderer.update({
      markers: [{ id: "job-1", point: moscow, role: "job" }],
      polylines: [{ id: "route-1", points: [moscow, kazan], color: "#2563eb" }],
    });

    assert.equal(renderer.scene?.markers[0]?.id, "job-1");
    assert.equal(renderer.scene?.polylines[0]?.points.length, 2);
  });
});

describe("2GIS capability profile", () => {
  it("declares supported MVP features and explicit gaps", () => {
    assert.equal(TWO_GIS_CAPABILITIES.optimization.skills, true);
    assert.equal(TWO_GIS_CAPABILITIES.optimization.hardTimeWindows, true);
    assert.equal(TWO_GIS_CAPABILITIES.optimization.customSoftWindowPenalties, false);
    assert.equal(TWO_GIS_CAPABILITIES.optimization.sharedResources, false);
    assert.equal(TWO_GIS_CAPABILITIES.optimization.lockedVisits, false);
  });
});

describe("provider-independent plan evaluation", () => {
  const problem: PlanningProblem = {
    id: "problem-1",
    horizon: { startAt: "2026-08-27T08:00:00+03:00", endAt: "2026-08-27T18:00:00+03:00" },
    profile: { mode: "driving", traffic: "historical" },
    jobs: [
      {
        id: "job-1",
        location: moscow,
        serviceDurationSeconds: 1_800,
        state: "new",
        changePolicy: "free",
        hardTimeWindows: [{ startAt: "2026-08-27T09:00:00+03:00", endAt: "2026-08-27T11:00:00+03:00" }],
        requiredSkills: ["electrical"],
        requiredResources: [{ kind: "equipment", allTags: ["tester"] }],
        priority: 100,
        dropPenalty: 10_000,
      },
    ],
    agents: [
      {
        id: "agent-1",
        skills: ["electrical"],
        fixedResourceTags: ["tester"],
        shifts: [{
          id: "shift-1",
          window: { startAt: "2026-08-27T08:00:00+03:00", endAt: "2026-08-27T18:00:00+03:00" },
          startLocation: moscow,
        }],
      },
    ],
    resources: [
      {
        id: "resource-1",
        kind: "equipment",
        tags: ["tester"],
        availability: [{ startAt: "2026-08-27T08:00:00+03:00", endAt: "2026-08-27T18:00:00+03:00" }],
        assignment: { kind: "fixed_to_agent", agentId: "agent-1" },
      },
    ],
    objectives: [
      { kind: "minimize_sla_violation", weight: 1 },
      { kind: "minimize_travel_time", weight: 1 },
    ],
  };

  const validProposal: PlanProposal = {
    id: "plan-1",
    problemId: problem.id,
    status: "ready",
    routes: [{
      agentId: "agent-1",
      shiftId: "shift-1",
      visits: [{
        jobId: "job-1",
        arrivalAt: "2026-08-27T09:20:00+03:00",
        serviceStartAt: "2026-08-27T09:20:00+03:00",
        serviceEndAt: "2026-08-27T09:50:00+03:00",
        travelSecondsFromPrevious: 1_200,
        distanceMetersFromPrevious: 8_000,
        resourceIds: ["resource-1"],
      }],
      totalTravelSeconds: 1_200,
      totalDistanceMeters: 8_000,
    }],
    unassigned: [],
    changes: [],
    approvals: [],
    diagnostics: { durationMs: 20, engineId: "test", warnings: [] },
  };

  it("accepts a feasible normalized proposal", () => {
    const evaluation = evaluatePlan(problem, validProposal);
    const result = evaluation.validation;
    assert.equal(result.valid, true);
    assert.equal(result.hardViolationCount, 0);
    assert.deepEqual(result.issues, []);
    assert.equal(evaluation.score.hardViolations, 0);
  });

  it("rejects optimizer output that violates independent business constraints", () => {
    const invalidProposal: PlanProposal = {
      ...validProposal,
      routes: [{
        ...validProposal.routes[0]!,
        visits: [{
          ...validProposal.routes[0]!.visits[0]!,
          serviceStartAt: "2026-08-27T12:00:00+03:00",
          serviceEndAt: "2026-08-27T12:30:00+03:00",
          resourceIds: [],
        }],
      }],
    };
    const result = validatePlan(problem, invalidProposal);
    assert.equal(result.valid, false);
    assert.ok(result.issues.some((issue) => issue.code === "HARD_TIME_WINDOW_VIOLATION"));
    assert.ok(result.issues.some((issue) => issue.code === "RESOURCE_REQUIREMENT_UNMET"));
  });

  it("rejects service that overlaps an agent break", () => {
    const problemWithBreak: PlanningProblem = {
      ...problem,
      agents: [{
        ...problem.agents[0]!,
        shifts: [{ ...problem.agents[0]!.shifts[0]!, breaks: [{ startAt: "2026-08-27T09:30:00+03:00", endAt: "2026-08-27T10:00:00+03:00" }] }],
      }],
    };
    const result = validatePlan(problemWithBreak, validProposal);
    assert.equal(result.valid, false);
    assert.ok(result.issues.some((issue) => issue.code === "SHIFT_BREAK_VIOLATION"));
  });

  it("rejects travel that consumes an agent break", () => {
    const problemWithBreak: PlanningProblem = {
      ...problem,
      agents: [{
        ...problem.agents[0]!,
        shifts: [{ ...problem.agents[0]!.shifts[0]!, breaks: [{ startAt: "2026-08-27T09:00:00+03:00", endAt: "2026-08-27T09:15:00+03:00" }] }],
      }],
    };
    const result = validatePlan(problemWithBreak, validProposal);
    assert.equal(result.valid, false);
    assert.ok(result.issues.some((issue) => issue.code === "SHIFT_BREAK_VIOLATION" && issue.message.includes("Переезд")));
  });

  it("requires and validates the final leg to the shift end location", () => {
    const problemWithReturn: PlanningProblem = {
      ...problem,
      agents: [{
        ...problem.agents[0]!,
        shifts: [{ ...problem.agents[0]!.shifts[0]!, endLocation: kazan }],
      }],
    };
    const missingReturn = validatePlan(problemWithReturn, validProposal);
    assert.equal(missingReturn.valid, false);
    assert.ok(missingReturn.issues.some((issue) => issue.code === "MISSING_END_LEG"));

    const proposalWithReturn: PlanProposal = {
      ...validProposal,
      routes: [{
        ...validProposal.routes[0]!,
        endLeg: {
          departureAt: "2026-08-27T10:00:00+03:00",
          arrivalAt: "2026-08-27T10:10:00+03:00",
          travelSeconds: 600,
          distanceMeters: 2_000,
        },
        totalTravelSeconds: 1_800,
        totalDistanceMeters: 10_000,
      }],
    };
    const result = validatePlan(problemWithReturn, proposalWithReturn);
    assert.equal(result.valid, true);
  });

  it("scores and compares proposals lexicographically", () => {
    const assignedScore = scorePlan(problem, validProposal);
    const unassignedProposal: PlanProposal = {
      ...validProposal,
      routes: [],
      unassigned: [{ jobId: "job-1", reason: "excluded_by_objective" }],
    };
    const unassignedScore = scorePlan(problem, unassignedProposal);
    assert.equal(assignedScore.unassignedPenalty, 0);
    assert.equal(unassignedScore.unassignedPenalty, 10_000);
    assert.ok(comparePlanScores(assignedScore, unassignedScore) < 0);
  });
});
