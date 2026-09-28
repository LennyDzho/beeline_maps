import type { TimeWindow } from "./common.js";
import type {
  BaselineVisit,
  PlanProposal,
  PlannedAgentRoute,
  PlannedVisit,
  PlanningAgent,
  PlanningJob,
  PlanningProblem,
  PlanningResource,
  ResourceRequirement,
} from "./optimization.js";

export type PlanValidationCode =
  | "PROBLEM_ID_MISMATCH"
  | "UNKNOWN_AGENT"
  | "UNKNOWN_SHIFT"
  | "DUPLICATE_ROUTE"
  | "UNKNOWN_JOB"
  | "DUPLICATE_JOB"
  | "MISSING_JOB"
  | "INACTIVE_JOB_SCHEDULED"
  | "INVALID_TIMESTAMP"
  | "INVALID_SEQUENCE"
  | "INVALID_SERVICE_DURATION"
  | "HARD_TIME_WINDOW_VIOLATION"
  | "SHIFT_WINDOW_VIOLATION"
  | "SHIFT_BREAK_VIOLATION"
  | "MISSING_END_LEG"
  | "SKILL_MISMATCH"
  | "EQUIPMENT_MISMATCH"
  | "UNKNOWN_RESOURCE"
  | "RESOURCE_REQUIREMENT_UNMET"
  | "RESOURCE_ASSIGNMENT_MISMATCH"
  | "RESOURCE_UNAVAILABLE"
  | "RESOURCE_OVERLAP"
  | "AGENT_JOB_LIMIT_EXCEEDED"
  | "AGENT_TRAVEL_LIMIT_EXCEEDED"
  | "AGENT_DISTANCE_LIMIT_EXCEEDED"
  | "IMMUTABLE_VISIT_CHANGED"
  | "APPROVAL_REQUIRED"
  | "APPROVAL_STATUS_MISMATCH"
  | "INVALID_ROUTE_TOTAL";

export interface PlanValidationIssue {
  readonly severity: "error" | "warning";
  readonly code: PlanValidationCode;
  readonly message: string;
  readonly jobId?: string;
  readonly agentId?: string;
  readonly resourceId?: string;
}

export interface PlanValidationResult {
  readonly valid: boolean;
  readonly hardViolationCount: number;
  readonly issues: ReadonlyArray<PlanValidationIssue>;
}

export interface NormalizedPlanScore {
  readonly hardViolations: number;
  readonly slaViolationSeconds: number;
  readonly unassignedPenalty: number;
  readonly confirmedVisitChanges: number;
  readonly softWindowPenalty: number;
  readonly overtimeSeconds: number;
  readonly totalTravelSeconds: number;
  readonly loadImbalanceSeconds: number;
  readonly totalDistanceMeters: number;
}

export interface PlanEvaluation {
  readonly validation: PlanValidationResult;
  readonly score: NormalizedPlanScore;
}

interface ResourceUsage {
  readonly resourceId: string;
  readonly jobId: string;
  readonly agentId: string;
  readonly startMs: number;
  readonly endMs: number;
}

interface VisitContext {
  readonly route: PlannedAgentRoute;
  readonly visit: PlannedVisit;
  readonly sequence: number;
}

const TIMESTAMP_WITH_OFFSET = /(Z|[+-]\d{2}:\d{2})$/i;
const TIME_TOLERANCE_MS = 1_000;

/**
 * Pure, provider-independent validation of a normalized plan proposal.
 * It performs no I/O and trusts neither the optimizer nor its diagnostics.
 */
export function validatePlan(
  problem: PlanningProblem,
  proposal: PlanProposal,
): PlanValidationResult {
  const issues: PlanValidationIssue[] = [];
  const jobs = new Map(problem.jobs.map((job) => [job.id, job]));
  const agents = new Map(problem.agents.map((agent) => [agent.id, agent]));
  const resources = new Map(problem.resources.map((resource) => [resource.id, resource]));
  const assigned = new Map<string, VisitContext>();
  const unassigned = new Set<string>();
  const routeKeys = new Set<string>();
  const resourceUsages: ResourceUsage[] = [];

  if (proposal.problemId !== problem.id) {
    issues.push(error("PROBLEM_ID_MISMATCH", `План относится к задаче ${proposal.problemId}, ожидалась ${problem.id}.`));
  }

  for (const route of proposal.routes) {
    const agent = agents.get(route.agentId);
    if (!agent) {
      issues.push(error("UNKNOWN_AGENT", `Неизвестный исполнитель ${route.agentId}.`, { agentId: route.agentId }));
      continue;
    }

    const shift = agent.shifts.find((candidate) => candidate.id === route.shiftId);
    if (!shift) {
      issues.push(error("UNKNOWN_SHIFT", `Смена ${route.shiftId} не принадлежит исполнителю ${route.agentId}.`, { agentId: route.agentId }));
      continue;
    }

    const routeKey = `${route.agentId}\u0000${route.shiftId}`;
    if (routeKeys.has(routeKey)) {
      issues.push(error("DUPLICATE_ROUTE", `Для исполнителя ${route.agentId} и смены ${route.shiftId} создано несколько маршрутов.`, { agentId: route.agentId }));
    }
    routeKeys.add(routeKey);

    validateRouteTotals(route, agent, issues);
    let previousEndMs = parseTimestamp(shift.window.startAt);

    route.visits.forEach((visit, index) => {
      const sequence = index + 1;
      const job = jobs.get(visit.jobId);
      if (!job) {
        issues.push(error("UNKNOWN_JOB", `Маршрут содержит неизвестную заявку ${visit.jobId}.`, { jobId: visit.jobId, agentId: route.agentId }));
        return;
      }

      if (assigned.has(job.id)) {
        issues.push(error("DUPLICATE_JOB", `Заявка ${job.id} назначена более одного раза.`, { jobId: job.id, agentId: route.agentId }));
      } else {
        assigned.set(job.id, { route, visit, sequence });
      }

      if (job.state === "completed" || job.state === "cancelled") {
        issues.push(error("INACTIVE_JOB_SCHEDULED", `Заявка ${job.id} в состоянии ${job.state} не должна входить в новый маршрут.`, { jobId: job.id, agentId: route.agentId }));
      }

      const timestamps = parseVisitTimestamps(visit);
      if (!timestamps) {
        issues.push(error("INVALID_TIMESTAMP", `Заявка ${job.id} содержит некорректное время визита.`, { jobId: job.id, agentId: route.agentId }));
        return;
      }

      if (visit.travelSecondsFromPrevious < 0 || visit.distanceMetersFromPrevious < 0) {
        issues.push(error("INVALID_ROUTE_TOTAL", `У заявки ${job.id} отрицательное время или расстояние переезда.`, { jobId: job.id, agentId: route.agentId }));
      }

      if (timestamps.serviceStartMs < timestamps.arrivalMs || timestamps.serviceEndMs < timestamps.serviceStartMs) {
        issues.push(error("INVALID_SEQUENCE", `Нарушена последовательность arrival → serviceStart → serviceEnd для заявки ${job.id}.`, { jobId: job.id, agentId: route.agentId }));
      }

      const travelStartMs = timestamps.arrivalMs - visit.travelSecondsFromPrevious * 1_000;
      if (previousEndMs !== undefined) {
        if (travelStartMs + TIME_TOLERANCE_MS < previousEndMs) {
          issues.push(error("INVALID_SEQUENCE", `Переезд к заявке ${job.id} не помещается между соседними визитами.`, { jobId: job.id, agentId: route.agentId }));
        }
      }
      previousEndMs = timestamps.serviceEndMs;

      const actualServiceSeconds = Math.round((timestamps.serviceEndMs - timestamps.serviceStartMs) / 1_000);
      if (Math.abs(actualServiceSeconds - job.serviceDurationSeconds) > 1) {
        issues.push(error("INVALID_SERVICE_DURATION", `Для заявки ${job.id} запланировано ${actualServiceSeconds} с обслуживания вместо ${job.serviceDurationSeconds} с.`, { jobId: job.id, agentId: route.agentId }));
      }

      if (job.hardTimeWindows.length > 0 && !job.hardTimeWindows.some((window) => containsServiceStart(window, timestamps.serviceStartMs))) {
        issues.push(error("HARD_TIME_WINDOW_VIOLATION", `Заявка ${job.id} назначена вне жёсткого временного окна.`, { jobId: job.id, agentId: route.agentId }));
      }
      if (job.releaseAt && (parseTimestamp(job.releaseAt) === undefined || timestamps.serviceStartMs < parseTimestamp(job.releaseAt)!)) {
        issues.push(error("HARD_TIME_WINDOW_VIOLATION", `Заявка ${job.id} назначена раньше момента её доступности.`, { jobId: job.id, agentId: route.agentId }));
      }

      if (!containsInterval(shift.window, timestamps.arrivalMs, timestamps.serviceEndMs)) {
        issues.push(error("SHIFT_WINDOW_VIOLATION", `Визит ${job.id} выходит за границы смены ${route.shiftId}.`, { jobId: job.id, agentId: route.agentId }));
      }

      if (shift.breaks?.some((window) => intervalsOverlap(window, timestamps.serviceStartMs, timestamps.serviceEndMs))) {
        issues.push(error("SHIFT_BREAK_VIOLATION", `Обслуживание заявки ${job.id} пересекается с перерывом исполнителя.`, { jobId: job.id, agentId: route.agentId }));
      }
      if (shift.breaks?.some((window) => intervalsOverlap(window, travelStartMs, timestamps.arrivalMs))) {
        issues.push(error("SHIFT_BREAK_VIOLATION", `Переезд к заявке ${job.id} пересекается с перерывом исполнителя.`, { jobId: job.id, agentId: route.agentId }));
      }

      const missingSkills = job.requiredSkills?.filter((skill) => !agent.skills.includes(skill)) ?? [];
      if (missingSkills.length > 0) {
        issues.push(error("SKILL_MISMATCH", `Исполнителю ${route.agentId} не хватает навыков: ${missingSkills.join(", ")}.`, { jobId: job.id, agentId: route.agentId }));
      }
      if (agent.availableEquipmentIds !== undefined && job.requiredEquipmentIds?.some(id => !agent.availableEquipmentIds!.includes(id))) {
        issues.push(error("EQUIPMENT_MISMATCH", `У выехавшей бригады ${route.agentId} нет всего оборудования для заявки ${job.id}.`, { jobId: job.id, agentId: route.agentId }));
      }

      validateVisitResources(
        job,
        agent,
        visit,
        timestamps.serviceStartMs,
        timestamps.serviceEndMs,
        resources,
        issues,
        resourceUsages,
      );
    });

    if (shift.endLocation && route.visits.length > 0) {
      const endLeg = route.endLeg;
      if (!endLeg) {
        issues.push(error("MISSING_END_LEG", `Маршрут исполнителя ${route.agentId} не содержит возвращение в конечную точку смены.`, { agentId: route.agentId }));
      } else {
        const departureMs = parseTimestamp(endLeg.departureAt);
        const arrivalMs = parseTimestamp(endLeg.arrivalAt);
        if (departureMs === undefined || arrivalMs === undefined) {
          issues.push(error("INVALID_TIMESTAMP", `Возвращение исполнителя ${route.agentId} содержит некорректное время.`, { agentId: route.agentId }));
        } else {
          if (endLeg.travelSeconds < 0 || endLeg.distanceMeters < 0) {
            issues.push(error("INVALID_ROUTE_TOTAL", `Возвращение исполнителя ${route.agentId} содержит отрицательное время или расстояние.`, { agentId: route.agentId }));
          }
          if ((previousEndMs !== undefined && departureMs + TIME_TOLERANCE_MS < previousEndMs)
            || Math.abs(arrivalMs - departureMs - endLeg.travelSeconds * 1_000) > TIME_TOLERANCE_MS) {
            issues.push(error("INVALID_SEQUENCE", `Некорректно рассчитано возвращение исполнителя ${route.agentId}.`, { agentId: route.agentId }));
          }
          if (!containsInterval(shift.window, departureMs, arrivalMs)) {
            issues.push(error("SHIFT_WINDOW_VIOLATION", `Возвращение исполнителя ${route.agentId} выходит за границы смены ${route.shiftId}.`, { agentId: route.agentId }));
          }
          if (shift.breaks?.some((window) => intervalsOverlap(window, departureMs, arrivalMs))) {
            issues.push(error("SHIFT_BREAK_VIOLATION", `Возвращение исполнителя ${route.agentId} пересекается с перерывом.`, { agentId: route.agentId }));
          }
        }
      }
    }
  }

  for (const item of proposal.unassigned) {
    if (!jobs.has(item.jobId)) {
      issues.push(error("UNKNOWN_JOB", `Список неназначенных содержит неизвестную заявку ${item.jobId}.`, { jobId: item.jobId }));
      continue;
    }
    if (unassigned.has(item.jobId) || assigned.has(item.jobId)) {
      issues.push(error("DUPLICATE_JOB", `Заявка ${item.jobId} одновременно назначена или повторяется в неназначенных.`, { jobId: item.jobId }));
    }
    unassigned.add(item.jobId);
  }

  for (const job of problem.jobs) {
    if (!assigned.has(job.id) && !unassigned.has(job.id)) {
      issues.push(error("MISSING_JOB", `Для заявки ${job.id} отсутствует маршрут и причина неназначения.`, { jobId: job.id }));
    }

    const context = assigned.get(job.id);
    const changed = hasBaselineChanged(job.baseline, context);
    if (job.changePolicy === "immutable" && changed) {
      issues.push(error("IMMUTABLE_VISIT_CHANGED", `Неизменяемый визит ${job.id} был перемещён или снят с маршрута.`, {
        jobId: job.id,
        ...(context ? { agentId: context.route.agentId } : {}),
      }));
    }
    if (job.changePolicy === "dispatcher_approval_required" && hasClientCommitmentChanged(job.baseline, context)) {
      const hasApproval = proposal.approvals.some((approval) => approval.jobId === job.id && approval.blocking && approval.kind === "dispatcher_confirmed_client_notified");
      if (!hasApproval) {
        issues.push(error("APPROVAL_REQUIRED", `Изменение подтверждённого визита ${job.id} требует согласования диспетчера.`, {
          jobId: job.id,
          ...(context ? { agentId: context.route.agentId } : {}),
        }));
      }
    }
  }

  validateResourceOverlaps(resourceUsages, issues);

  if (proposal.approvals.length > 0 && proposal.status !== "requires_approval") {
    issues.push(error("APPROVAL_STATUS_MISMATCH", "План содержит блокирующие согласования, но не имеет статуса requires_approval."));
  }
  if (proposal.status === "requires_approval" && proposal.approvals.length === 0) {
    issues.push(error("APPROVAL_STATUS_MISMATCH", "План требует согласования, но не содержит ни одного требования."));
  }

  const hardViolationCount = issues.filter((issue) => issue.severity === "error").length;
  return { valid: hardViolationCount === 0, hardViolationCount, issues };
}

/** Calculates a provider-neutral score. Every field is minimized. */
export function scorePlan(
  problem: PlanningProblem,
  proposal: PlanProposal,
  validation: PlanValidationResult = validatePlan(problem, proposal),
): NormalizedPlanScore {
  const jobs = new Map(problem.jobs.map((job) => [job.id, job]));
  const agents = new Map(problem.agents.map((agent) => [agent.id, agent]));
  const assigned = new Map<string, VisitContext>();
  let slaViolationSeconds = 0;
  let softWindowPenalty = 0;
  let confirmedVisitChanges = 0;
  let overtimeSeconds = 0;

  for (const route of proposal.routes) {
    route.visits.forEach((visit, index) => {
      assigned.set(visit.jobId, { route, visit, sequence: index + 1 });
      const job = jobs.get(visit.jobId);
      const serviceStartMs = parseTimestamp(visit.serviceStartAt);
      if (!job || serviceStartMs === undefined) return;

      slaViolationSeconds += hardWindowLatenessSeconds(job.hardTimeWindows, serviceStartMs);
      softWindowPenalty += softPenalty(job, serviceStartMs);
    });

    const shift = agents.get(route.agentId)?.shifts.find((candidate) => candidate.id === route.shiftId);
    const lastVisit = route.visits.at(-1);
    const lastEndMs = route.endLeg ? parseTimestamp(route.endLeg.arrivalAt) : lastVisit ? parseTimestamp(lastVisit.serviceEndAt) : undefined;
    const shiftEndMs = shift ? parseTimestamp(shift.window.endAt) : undefined;
    if (lastEndMs !== undefined && shiftEndMs !== undefined) {
      overtimeSeconds += Math.max(0, Math.round((lastEndMs - shiftEndMs) / 1_000));
    }
  }

  for (const job of problem.jobs) {
    if (job.changePolicy !== "free" && hasBaselineChanged(job.baseline, assigned.get(job.id))) {
      confirmedVisitChanges += 1;
    }
  }

  const loads = proposal.routes.map((route) => route.totalTravelSeconds + route.visits.reduce((total, visit) => {
    const job = jobs.get(visit.jobId);
    return total + (job?.serviceDurationSeconds ?? 0);
  }, 0));
  const meanLoad = loads.length > 0 ? loads.reduce((sum, value) => sum + value, 0) / loads.length : 0;
  const loadImbalanceSeconds = loads.length > 0
    ? Math.round(loads.reduce((sum, value) => sum + Math.abs(value - meanLoad), 0) / loads.length)
    : 0;

  return {
    hardViolations: validation.hardViolationCount,
    slaViolationSeconds,
    unassignedPenalty: proposal.unassigned.reduce((total, item) => {
      const job = jobs.get(item.jobId);
      return total + (job?.dropPenalty ?? Math.max(1, job?.priority ?? 1));
    }, 0),
    confirmedVisitChanges,
    softWindowPenalty,
    overtimeSeconds,
    totalTravelSeconds: proposal.routes.reduce((total, route) => total + route.totalTravelSeconds, 0),
    loadImbalanceSeconds,
    totalDistanceMeters: proposal.routes.reduce((total, route) => total + route.totalDistanceMeters, 0),
  };
}

/** Convenience entry point used after any local or external optimizer. */
export function evaluatePlan(problem: PlanningProblem, proposal: PlanProposal): PlanEvaluation {
  const validation = validatePlan(problem, proposal);
  return { validation, score: scorePlan(problem, proposal, validation) };
}

/** Negative means left is better, positive means right is better. */
export function comparePlanScores(left: NormalizedPlanScore, right: NormalizedPlanScore): number {
  const leftTuple = scoreTuple(left);
  const rightTuple = scoreTuple(right);
  for (let index = 0; index < leftTuple.length; index += 1) {
    const difference = leftTuple[index]! - rightTuple[index]!;
    if (difference !== 0) return difference;
  }
  return 0;
}

function scoreTuple(score: NormalizedPlanScore): ReadonlyArray<number> {
  return [
    score.hardViolations,
    score.slaViolationSeconds,
    score.unassignedPenalty,
    score.confirmedVisitChanges,
    score.softWindowPenalty,
    score.overtimeSeconds,
    score.totalTravelSeconds,
    score.loadImbalanceSeconds,
    score.totalDistanceMeters,
  ];
}

function validateRouteTotals(route: PlannedAgentRoute, agent: PlanningAgent, issues: PlanValidationIssue[]): void {
  if (!Number.isFinite(route.totalTravelSeconds) || !Number.isFinite(route.totalDistanceMeters) || route.totalTravelSeconds < 0 || route.totalDistanceMeters < 0) {
    issues.push(error("INVALID_ROUTE_TOTAL", `Маршрут исполнителя ${route.agentId} содержит некорректные итоги.`, { agentId: route.agentId }));
  }
  if (agent.maxJobs !== undefined && route.visits.length > agent.maxJobs) {
    issues.push(error("AGENT_JOB_LIMIT_EXCEEDED", `Исполнителю ${route.agentId} назначено ${route.visits.length} заявок при лимите ${agent.maxJobs}.`, { agentId: route.agentId }));
  }
  if (agent.maxTravelSeconds !== undefined && route.totalTravelSeconds > agent.maxTravelSeconds) {
    issues.push(error("AGENT_TRAVEL_LIMIT_EXCEEDED", `Исполнитель ${route.agentId} превышает лимит времени в пути.`, { agentId: route.agentId }));
  }
  if (agent.maxDistanceMeters !== undefined && route.totalDistanceMeters > agent.maxDistanceMeters) {
    issues.push(error("AGENT_DISTANCE_LIMIT_EXCEEDED", `Исполнитель ${route.agentId} превышает лимит дистанции.`, { agentId: route.agentId }));
  }
  const expectedTravelSeconds = route.visits.reduce((sum, visit) => sum + visit.travelSecondsFromPrevious, 0) + (route.endLeg?.travelSeconds ?? 0);
  const expectedDistanceMeters = route.visits.reduce((sum, visit) => sum + visit.distanceMetersFromPrevious, 0) + (route.endLeg?.distanceMeters ?? 0);
  if (Math.abs(route.totalTravelSeconds - expectedTravelSeconds) > 1 || Math.abs(route.totalDistanceMeters - expectedDistanceMeters) > 1) {
    issues.push(error("INVALID_ROUTE_TOTAL", `Итоги маршрута исполнителя ${route.agentId} не совпадают с суммой его переездов.`, { agentId: route.agentId }));
  }
}

function validateVisitResources(
  job: PlanningJob,
  agent: PlanningAgent,
  visit: PlannedVisit,
  startMs: number,
  endMs: number,
  resources: ReadonlyMap<string, PlanningResource>,
  issues: PlanValidationIssue[],
  usages: ResourceUsage[],
): void {
  const selected = (visit.resourceIds ?? []).flatMap((resourceId) => {
    const resource = resources.get(resourceId);
    if (!resource) {
      issues.push(error("UNKNOWN_RESOURCE", `Для заявки ${job.id} указан неизвестный ресурс ${resourceId}.`, { jobId: job.id, agentId: agent.id, resourceId }));
      return [];
    }
    return [resource];
  });

  for (const requirement of job.requiredResources ?? []) {
    const matches = selected.filter((resource) => resourceMatches(resource, requirement));
    if (matches.length < (requirement.quantity ?? 1)) {
      issues.push(error("RESOURCE_REQUIREMENT_UNMET", `Для заявки ${job.id} не выполнено требование к ресурсу ${requirement.kind}.`, { jobId: job.id, agentId: agent.id }));
    }
  }

  for (const resource of selected) {
    if (resource.assignment.kind === "fixed_to_agent" && resource.assignment.agentId !== agent.id) {
      issues.push(error("RESOURCE_ASSIGNMENT_MISMATCH", `Ресурс ${resource.id} закреплён за другим исполнителем.`, { jobId: job.id, agentId: agent.id, resourceId: resource.id }));
    }
    if (!resource.availability.some((window) => containsInterval(window, startMs, endMs))) {
      issues.push(error("RESOURCE_UNAVAILABLE", `Ресурс ${resource.id} недоступен во время заявки ${job.id}.`, { jobId: job.id, agentId: agent.id, resourceId: resource.id }));
    }
    usages.push({ resourceId: resource.id, jobId: job.id, agentId: agent.id, startMs, endMs });
  }
}

function validateResourceOverlaps(usages: ReadonlyArray<ResourceUsage>, issues: PlanValidationIssue[]): void {
  const byResource = new Map<string, ResourceUsage[]>();
  for (const usage of usages) {
    byResource.set(usage.resourceId, [...(byResource.get(usage.resourceId) ?? []), usage]);
  }
  for (const [resourceId, entries] of byResource) {
    const sorted = [...entries].sort((left, right) => left.startMs - right.startMs);
    for (let index = 1; index < sorted.length; index += 1) {
      const previous = sorted[index - 1]!;
      const current = sorted[index]!;
      if (current.startMs < previous.endMs && (current.jobId !== previous.jobId || current.agentId !== previous.agentId)) {
        issues.push(error("RESOURCE_OVERLAP", `Ресурс ${resourceId} одновременно используется заявками ${previous.jobId} и ${current.jobId}.`, { jobId: current.jobId, agentId: current.agentId, resourceId }));
      }
    }
  }
}

function resourceMatches(resource: PlanningResource, requirement: ResourceRequirement): boolean {
  if (resource.kind !== requirement.kind) return false;
  if (requirement.allTags?.some((tag) => !resource.tags.includes(tag))) return false;
  if (requirement.anyTags && requirement.anyTags.length > 0 && !requirement.anyTags.some((tag) => resource.tags.includes(tag))) return false;
  return true;
}

/** A pending requirement is a proposal, never evidence that a client was notified. */
export function requireClientVisitApprovals(problem: PlanningProblem, proposal: PlanProposal): PlanProposal {
  const assigned = new Map<string, VisitContext>();
  for (const route of proposal.routes) route.visits.forEach((visit, index) => assigned.set(visit.jobId, { route, visit, sequence: index + 1 }));
  const approvals = problem.jobs.filter(job => job.changePolicy === "dispatcher_approval_required" && hasClientCommitmentChanged(job.baseline, assigned.get(job.id)))
    .map(job => ({ id: `${proposal.id}:${job.id}`, jobId: job.id, kind: "dispatcher_confirmed_client_notified" as const, blocking: true as const,
      reason: "Изменяется подтверждённый клиенту визит. Диспетчер должен сообщить клиенту до публикации." }));
  return { ...proposal, approvals, status: approvals.length ? "requires_approval" : proposal.status === "requires_approval" ? "ready" : proposal.status };
}

function hasClientCommitmentChanged(baseline: BaselineVisit | undefined, context: VisitContext | undefined): boolean {
  if (!baseline) return false;
  if (!context) return true;
  // Arrival may include waiting before the promised start; the app stores the
  // service appointment, not an independently confirmed earlier road arrival.
  return baseline.agentId !== context.route.agentId || baseline.sequence !== context.sequence
    || !sameTimestamp(baseline.serviceStartAt, context.visit.serviceStartAt)
    || !sameTimestamp(baseline.serviceEndAt, context.visit.serviceEndAt);
}

function hasBaselineChanged(baseline: BaselineVisit | undefined, context: VisitContext | undefined): boolean {
  if (!baseline) return false;
  if (!context) return true;
  return baseline.agentId !== context.route.agentId
    || baseline.sequence !== context.sequence
    || !sameTimestamp(baseline.arrivalAt, context.visit.arrivalAt)
    || !sameTimestamp(baseline.serviceStartAt, context.visit.serviceStartAt)
    || !sameTimestamp(baseline.serviceEndAt, context.visit.serviceEndAt);
}

function sameTimestamp(left: string, right: string): boolean {
  const leftMs = parseTimestamp(left);
  const rightMs = parseTimestamp(right);
  return leftMs !== undefined && rightMs !== undefined && Math.abs(leftMs - rightMs) <= TIME_TOLERANCE_MS;
}

function parseVisitTimestamps(visit: PlannedVisit) {
  const arrivalMs = parseTimestamp(visit.arrivalAt);
  const serviceStartMs = parseTimestamp(visit.serviceStartAt);
  const serviceEndMs = parseTimestamp(visit.serviceEndAt);
  if (arrivalMs === undefined || serviceStartMs === undefined || serviceEndMs === undefined) return undefined;
  return { arrivalMs, serviceStartMs, serviceEndMs };
}

function parseTimestamp(value: string): number | undefined {
  if (!TIMESTAMP_WITH_OFFSET.test(value)) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function containsServiceStart(window: TimeWindow, serviceStartMs: number): boolean {
  const startMs = parseTimestamp(window.startAt);
  const endMs = parseTimestamp(window.endAt);
  return startMs !== undefined && endMs !== undefined && serviceStartMs >= startMs && serviceStartMs <= endMs;
}

function containsInterval(window: TimeWindow, startMs: number, endMs: number): boolean {
  const windowStartMs = parseTimestamp(window.startAt);
  const windowEndMs = parseTimestamp(window.endAt);
  return windowStartMs !== undefined && windowEndMs !== undefined && startMs >= windowStartMs && endMs <= windowEndMs;
}

function intervalsOverlap(window: TimeWindow, startMs: number, endMs: number): boolean {
  const windowStartMs = parseTimestamp(window.startAt);
  const windowEndMs = parseTimestamp(window.endAt);
  return windowStartMs !== undefined && windowEndMs !== undefined && startMs < windowEndMs && endMs > windowStartMs;
}

function hardWindowLatenessSeconds(windows: ReadonlyArray<TimeWindow>, serviceStartMs: number): number {
  if (windows.length === 0) return 0;
  const ends = windows.flatMap((window) => {
    const parsed = parseTimestamp(window.endAt);
    return parsed === undefined ? [] : [parsed];
  });
  return ends.length === 0 ? 0 : Math.max(0, Math.round((serviceStartMs - Math.max(...ends)) / 1_000));
}

function softPenalty(job: PlanningJob, serviceStartMs: number): number {
  if (!job.softTimeWindows || job.softTimeWindows.length === 0) return 0;
  const penalties = job.softTimeWindows.flatMap((window) => {
    const startMs = parseTimestamp(window.startAt);
    const endMs = parseTimestamp(window.endAt);
    if (startMs === undefined || endMs === undefined) return [];
    const deviationMinutes = serviceStartMs < startMs
      ? (startMs - serviceStartMs) / 60_000
      : serviceStartMs > endMs
        ? (serviceStartMs - endMs) / 60_000
        : 0;
    return [deviationMinutes * window.penaltyPerMinute];
  });
  return penalties.length === 0 ? 0 : Math.round(Math.min(...penalties));
}

function error(
  code: PlanValidationCode,
  message: string,
  context: { readonly jobId?: string; readonly agentId?: string; readonly resourceId?: string } = {},
): PlanValidationIssue {
  return { severity: "error", code, message, ...context };
}
