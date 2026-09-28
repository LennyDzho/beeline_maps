import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  type PlanningProblem,
  type PlannedAgentRoute,
} from "@mmi/provider-contracts";
import { buildChanges } from "../app/lib/server/planning/route-scheduling.js";
import { isEngineerVisitOnDate } from "../app/dispatcher/data.js";
import {
  DEFAULT_PLANNING_SETTINGS,
  isOptimizationEngineId,
  isTravelMatrixProviderId,
} from "../app/lib/planning-settings.js";
import { addMinutesToTimestamp, formatDuration, isPlannedDurationMinutes } from "../app/lib/planned-duration.js";

const baseProblem: PlanningProblem = {
  id: "schedule-aware-problem",
  horizon: { startAt: "2026-08-31T08:00:00+03:00", endAt: "2026-08-31T12:00:00+03:00" },
  profile: { mode: "driving", traffic: "disabled" },
  jobs: [{
    id: "job-1",
    location: { lat: 55.76, lon: 37.64 },
    serviceDurationSeconds: 30 * 60,
    state: "new",
    changePolicy: "free",
    hardTimeWindows: [{ startAt: "2026-08-31T08:00:00+03:00", endAt: "2026-08-31T11:00:00+03:00" }],
    priority: 3,
    dropPenalty: 300,
  }],
  agents: [{
    id: "agent-1",
    skills: [],
    fixedResourceTags: [],
    shifts: [{
      id: "shift-1",
      window: { startAt: "2026-08-31T08:00:00+03:00", endAt: "2026-08-31T12:00:00+03:00" },
      breaks: [{ startAt: "2026-08-31T09:00:00+03:00", endAt: "2026-08-31T10:00:00+03:00" }],
      startLocation: { lat: 55.75, lon: 37.61 },
      endLocation: { lat: 55.75, lon: 37.61 },
    }],
  }],
  resources: [],
  objectives: [{ kind: "minimize_travel_time", weight: 1 }],
};

describe("draft visit changes", () => {
  const job = {
    ...baseProblem.jobs[0]!, id: "A-1431",
    baseline: { agentId: "EMP-402", sequence: 3, arrivalAt: "2026-08-20T11:00:00+03:00",
      serviceStartAt: "2026-08-20T11:00:00+03:00", serviceEndAt: "2026-08-20T12:00:00+03:00" },
  };
  const route: PlannedAgentRoute = {
    agentId: "EMP-402", shiftId: "SHIFT-1", totalTravelSeconds: 600, totalDistanceMeters: 1000,
    visits: [
      { jobId: "ORD-9020", arrivalAt: "2026-08-20T05:30:00.000Z", serviceStartAt: "2026-08-20T05:30:00.000Z",
        serviceEndAt: "2026-08-20T06:30:00.000Z", travelSecondsFromPrevious: 180, distanceMetersFromPrevious: 300 },
      { jobId: "A-1431", arrivalAt: "2026-08-20T06:37:00.000Z", serviceStartAt: "2026-08-20T08:00:00.000Z",
        serviceEndAt: "2026-08-20T09:00:00.000Z", travelSecondsFromPrevious: 420, distanceMetersFromPrevious: 700 },
    ],
  };

  it("marks sequence changes even when worker and service times stay the same", () => {
    assert.equal(buildChanges([job], [route])[0]?.kind, "order_changed");
    assert.equal(buildChanges([job], [route])[0]?.after?.sequence, 2);
    assert.equal(route.visits[1]?.jobId, "A-1431", "route order remains intact for publication");
  });

  it("still marks a start-time change", () => {
    const changed = { ...route, visits: route.visits.map(v => v.jobId === job.id
      ? { ...v, serviceStartAt: "2026-08-20T08:15:00.000Z", serviceEndAt: "2026-08-20T09:15:00.000Z" } : v) };
    assert.equal(buildChanges([job], [changed])[0]?.kind, "time_changed");
  });

  it("still marks a changed end time even with the same start", () => {
    const changed = { ...route, visits: route.visits.map(v => v.jobId === job.id
      ? { ...v, serviceEndAt: "2026-08-20T09:30:00.000Z" } : v) };
    assert.equal(buildChanges([job], [changed])[0]?.kind, "time_changed");
  });

  it("still marks reassignment at unchanged service times", () => {
    assert.equal(buildChanges([job], [{ ...route, agentId: "EMP-415" }])[0]?.kind, "agent_changed");
  });

  it("still marks new assignments and removals", () => {
    assert.equal(buildChanges([{ ...baseProblem.jobs[0]!, id: job.id }], [route])[0]?.kind, "assigned");
    assert.equal(buildChanges([job], [])[0]?.kind, "unassigned");
  });
});

describe("planning day view", () => {
  it("shows an engineer only the visits of the selected date", () => {
    const request = { assignee: "Алексей Иванов", dateTime: "2026-08-20T09:00" };

    assert.equal(isEngineerVisitOnDate(request, "Алексей Иванов", "2026-08-20"), true);
    assert.equal(isEngineerVisitOnDate(request, "Алексей Иванов", "2026-08-21"), false);
    assert.equal(isEngineerVisitOnDate(request, "Марина Соколова", "2026-08-20"), false);
  });
});

describe("global planning settings", () => {
  it("accepts only implemented optimization engines and matrix providers", () => {
    assert.equal(DEFAULT_PLANNING_SETTINGS.optimizationEngine, "pyvrp");
    assert.equal(DEFAULT_PLANNING_SETTINGS.travelMatrixProvider, "two_gis");
    assert.equal(isOptimizationEngineId("pyvrp"), true);
    assert.equal(isOptimizationEngineId("ortools"), true);
    assert.equal(isOptimizationEngineId("local_greedy"), false);
    assert.equal(isOptimizationEngineId("two_gis_tsp"), true);
    assert.equal(isOptimizationEngineId("2gis"), false);
    assert.equal(isTravelMatrixProviderId("two_gis"), true);
    assert.equal(isTravelMatrixProviderId("osrm"), true);
    assert.equal(isTravelMatrixProviderId("local_estimated"), false);
    assert.equal(isTravelMatrixProviderId("unknown"), false);
  });
});

describe("planned work duration", () => {
  it("adds the work type duration to a local start time without a timezone shift", () => {
    assert.equal(addMinutesToTimestamp("2026-09-02T23:30", 90), "2026-09-03T01:00");
    assert.equal(formatDuration(90), "1 ч 30 мин");
    assert.equal(isPlannedDurationMinutes(15), true);
    assert.equal(isPlannedDurationMinutes(480), true);
    assert.equal(isPlannedDurationMinutes(10), false);
  });
});
