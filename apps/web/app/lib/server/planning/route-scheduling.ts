import { getMatrixCell, type AgentShift, type BaselineVisit, type PlanChange,
  type PlannedAgentRoute, type PlannedRouteEndLeg, type PlannedVisit, type PlanningAgent,
  type PlanningJob, type PlanningProblem, type TravelTimeMatrix } from "@mmi/provider-contracts";

export function buildChanges(jobs: ReadonlyArray<PlanningJob>, routes: ReadonlyArray<PlannedAgentRoute>): PlanChange[] {
  const planned = new Map<string, { agentId: string; visit: PlannedVisit; sequence: number }>();
  for (const route of routes) route.visits.forEach((visit, index) => planned.set(visit.jobId, { agentId: route.agentId, visit, sequence: index + 1 }));
  return jobs.flatMap((job): PlanChange[] => {
    const afterContext = planned.get(job.id);
    const after = afterContext ? toBaseline(afterContext.agentId, afterContext.visit, afterContext.sequence) : undefined;
    if (!job.baseline) return after ? [{ jobId: job.id, kind: "assigned", after }] : [];
    if (!after) return [{ jobId: job.id, kind: "unassigned", before: job.baseline }];
    if (job.baseline.agentId !== after.agentId) return [{ jobId: job.id, kind: "agent_changed", before: job.baseline, after }];
    if (!sameTime(job.baseline.serviceStartAt, after.serviceStartAt) || !sameTime(job.baseline.serviceEndAt, after.serviceEndAt)) {
      return [{ jobId: job.id, kind: "time_changed", before: job.baseline, after }];
    }
    if (job.baseline.sequence !== after.sequence) return [{ jobId: job.id, kind: "order_changed", before: job.baseline, after }];
    return [];
  });
}

function toBaseline(agentId: string, visit: PlannedVisit, sequence: number): BaselineVisit {
  return { agentId, arrivalAt: visit.arrivalAt, serviceStartAt: visit.serviceStartAt, serviceEndAt: visit.serviceEndAt, sequence };
}

function sameTime(left: string, right: string): boolean {
  return Math.abs(parseTime(left) - parseTime(right)) <= 1_000;
}

function scheduleActivity(startMs: number, durationMs: number, breaks: AgentShift["breaks"]): { startMs: number; endMs: number } {
  let result = startMs;
  for (const window of [...(breaks ?? [])].sort((left, right) => parseTime(left.startAt) - parseTime(right.startAt))) {
    const breakStartMs = parseTime(window.startAt);
    const breakEndMs = parseTime(window.endAt);
    if (result < breakEndMs && result + durationMs > breakStartMs) result = breakEndMs;
  }
  return { startMs: result, endMs: result + durationMs };
}

function hasSkills(agent: PlanningAgent, job: PlanningJob): boolean {
  return (job.requiredSkills ?? []).every((skill) => agent.skills.includes(skill))
    && (agent.availableEquipmentIds === undefined || (job.requiredEquipmentIds ?? []).every(id => agent.availableEquipmentIds!.includes(id)));
}

export function shiftPointId(agentId: string, shiftId: string): string {
  return `shift:${agentId}:${shiftId}`;
}

export function shiftEndPointId(agentId: string, shiftId: string): string {
  return `shift-end:${agentId}:${shiftId}`;
}

export function jobPointId(jobId: string): string {
  return `job:${jobId}`;
}

function parseTime(value: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new RangeError(`Некорректное время планирования: ${value}`);
  return parsed;
}

/** Schedule an external solver's fixed order; never choose assignments or reorder jobs. */
export function scheduleFixedOrder(problem: PlanningProblem, agent: PlanningAgent, shift: AgentShift, jobIds: string[], matrix: TravelTimeMatrix): PlannedAgentRoute | undefined {
  return scheduleSequence(problem, agent, shift, jobIds, matrix, true)
    ?? scheduleSequence(problem, agent, shift, jobIds, matrix, false);
}

function scheduleSequence(problem: PlanningProblem, agent: PlanningAgent, shift: AgentShift, jobIds: string[], matrix: TravelTimeMatrix, honorPreferred: boolean): PlannedAgentRoute | undefined {
  if (!jobIds.length) return undefined;
  const jobsById = new Map(problem.jobs.map(job => [job.id, job]));
  if (jobIds.some(id => !jobsById.has(id) || !hasSkills(agent, jobsById.get(id)!))) return undefined;
  const endPointId = shift.endLocation ? shiftEndPointId(agent.id, shift.id) : undefined;
  const multiplier = agent.travelTimeMultiplier ?? 1;
  const shiftEndMs = parseTime(shift.window.endAt);
  let availableAtMs = parseTime(shift.window.startAt);
  let lastPointId = shiftPointId(agent.id, shift.id);
  let totalTravelSeconds = 0;
  let totalDistanceMeters = 0;
  const visits: PlannedVisit[] = [];

  for (const jobId of jobIds) {
    const candidateJob = jobsById.get(jobId)!;
    const cell = getMatrixCell(matrix, lastPointId, jobPointId(jobId));
    if (cell?.status !== "ok") return undefined;
    const travelSeconds = Math.ceil(cell.durationSeconds * multiplier);
    const travel = scheduleActivity(availableAtMs, travelSeconds * 1_000, shift.breaks ?? []);
    const arrivalMs = travel.endMs;
    const windows = candidateJob.hardTimeWindows.length > 0 ? candidateJob.hardTimeWindows : [shift.window];
    const preferredStartMs = honorPreferred && candidateJob.softTimeWindows?.length
      ? Math.min(...candidateJob.softTimeWindows.map(window => parseTime(window.startAt))) : Number.NEGATIVE_INFINITY;
    const feasible = windows.flatMap((window) => {
      const initialStartMs = Math.max(arrivalMs, preferredStartMs, parseTime(window.startAt), parseTime(shift.window.startAt), candidateJob.releaseAt ? parseTime(candidateJob.releaseAt) : Number.NEGATIVE_INFINITY);
      const serviceStartMs = scheduleActivity(initialStartMs, candidateJob.serviceDurationSeconds * 1_000, shift.breaks ?? []).startMs;
      const serviceEndMs = serviceStartMs + candidateJob.serviceDurationSeconds * 1_000;
      return serviceStartMs <= parseTime(window.endAt) && serviceEndMs <= shiftEndMs ? [{ serviceStartMs, serviceEndMs }] : [];
    }).sort((left, right) => left.serviceStartMs - right.serviceStartMs)[0];
    if (!feasible) return undefined;

    visits.push({
      jobId,
      arrivalAt: new Date(arrivalMs).toISOString(),
      serviceStartAt: new Date(feasible.serviceStartMs).toISOString(),
      serviceEndAt: new Date(feasible.serviceEndMs).toISOString(),
      travelSecondsFromPrevious: travelSeconds,
      distanceMetersFromPrevious: cell.distanceMeters,
    });
    totalTravelSeconds += travelSeconds;
    totalDistanceMeters += cell.distanceMeters;
    availableAtMs = feasible.serviceEndMs;
    lastPointId = jobPointId(jobId);
  }

  let endLeg: PlannedRouteEndLeg | undefined;
  if (endPointId) {
    const endCell = getMatrixCell(matrix, lastPointId, endPointId);
    if (endCell?.status !== "ok") return undefined;
    const returnTravelSeconds = Math.ceil(endCell.durationSeconds * multiplier);
    const returnTravel = scheduleActivity(availableAtMs, returnTravelSeconds * 1_000, shift.breaks ?? []);
    if (returnTravel.endMs > shiftEndMs) return undefined;
    endLeg = {
      departureAt: new Date(returnTravel.startMs).toISOString(),
      arrivalAt: new Date(returnTravel.endMs).toISOString(),
      travelSeconds: returnTravelSeconds,
      distanceMeters: endCell.distanceMeters,
    };
    totalTravelSeconds += returnTravelSeconds;
    totalDistanceMeters += endCell.distanceMeters;
  }

  if (agent.maxJobs !== undefined && visits.length > agent.maxJobs) return undefined;
  if (agent.maxTravelSeconds !== undefined && totalTravelSeconds > agent.maxTravelSeconds) return undefined;
  if (agent.maxDistanceMeters !== undefined && totalDistanceMeters > agent.maxDistanceMeters) return undefined;

  return {
    agentId: agent.id, shiftId: shift.id, visits,
    ...(endLeg ? { endLeg } : {}), totalTravelSeconds, totalDistanceMeters,
  };
}
