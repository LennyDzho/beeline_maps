import { serializePlanningResult, deserializePlanningResult } from "./result-storage";
import { env } from "cloudflare:workers";
import {
  evaluatePlan,
  requireClientVisitApprovals,
  ProviderError,
  type NormalizedPlanScore,
  type GeoPoint,
  type PlanningAgent,
  type PlanningJob,
  type PlanningProblem,
  type PlanProposal,
  type RouteGeometryPort,
  type TravelProfile,
} from "@mmi/provider-contracts";
import type { PlanningResult, PlanningRouteResult, PlanningUnassignedResult } from "@/app/dispatcher/planning-types";
import { GeocodingError, geocodeAddress } from "@/app/lib/server/geocoding";
import { DEFAULT_PLANNED_DURATION_MINUTES, addMinutesToTimestamp, isPlannedDurationMinutes } from "@/app/lib/planned-duration";
import { planningInputExpression, publicationGuard, readPlanningInput } from "./input-revisions";
import { comparePlan } from "./plan-comparison";
import { buildPreviousRoutes } from "./previous-routes";
import { schedulingChangeStatement } from "../scheduling-changes";
import { loadPlanningSettings } from "./settings-storage";
import { selectPlanningProviders } from "./providers";
import { optimizerObjectives } from "./service-optimizer";
import { availableAgents } from "./availability";
import { departmentEquipment } from "../brigade-equipment";
import { emergencyWindow } from "@/app/lib/request-scheduling";
import { isWorkerTransportSupported, workerTravelProfile, WORKER_TRANSPORT_SQL, WORKER_PLATE_SQL } from "./worker-travel-policy";

import { instantToRegionalTime, regionalTimeToInstant, scheduleTimeToInstant } from "@/app/lib/regional-time";
import { loadOrderCompositions } from "../work-order-composition";
import { listWorkerCompetencies } from "../work-catalog";
type JobRow = {
  client_visit_confirmed: number;
  created_at: string;
  assignee_name: string | null; had_assignment: number;
  scheduling_timezone: string; client_window_start: string | null; client_window_end: string | null;
  id: string;
  number: string;
  work_type_version_id: string;
  work_name: string;
  status: string;
  priority: "high" | "medium" | "low";
  scheduled_start: string;
  scheduled_end: string | null;
  planned_duration_minutes: number;
  assignee_worker_id: string | null;
  baseline_sequence: number | null;
  address: string;
  service_object_id: string | null;
  latitude: number | null;
  longitude: number | null;
};

type WorkerRow = {
  timezone: string;
  id: string;
  full_name: string;
  transport_mode: "car" | "transit";
  transport_details: string;
  start_address: string;
  start_latitude: number;
  start_longitude: number;
  schedule_name: string;
  work_start: string;
  work_end: string;
  break_start: string | null;
  break_end: string | null;
};


type ExcludedJob = {
  row: JobRow;
  code: "missing_client_window" | "geocoding_failed";
  reason: string;
};

export class PlanningServiceError extends Error {
  constructor(readonly code: "INVALID_DATE" | "NO_JOBS" | "NO_AGENTS" | "INVALID_PLAN" | "NOT_FOUND" | "DEPARTMENT_ERROR", message: string, readonly status: number) {
    super(message);
    this.name = "PlanningServiceError";
  }
}

// A common plan collects each department's writes and commits them together.
export type PlanBatchWriter = (statements: D1PreparedStatement[]) => Promise<unknown>;

export async function recalculatePlan(
  database: D1Database,
  organizationId: string,
  userId: string,
  serviceDate: string,
  eventAt?: string,
  writeBatch: PlanBatchWriter = statements => database.batch(statements),
  signal?: AbortSignal,
): Promise<PlanningResult> {
  assertServiceDate(serviceDate);
  const department=await database.prepare("SELECT timezone FROM organizations WHERE id=?").bind(organizationId).first<{timezone:string}>();
  if (eventAt !== undefined && (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/u.test(eventAt) || !Number.isFinite(Date.parse(eventAt)) || instantToRegionalTime(eventAt,department!.timezone).slice(0,10)!==serviceDate)) {
    throw new PlanningServiceError("INVALID_DATE","Время перепланирования должно относиться к выбранному дню подразделения.",400);
  }
  const inputRevision = await readPlanningInput(database, organizationId);
  const rows = await loadJobs(database, organizationId, serviceDate);
  if (rows.length === 0) throw new PlanningServiceError("NO_JOBS", `На ${serviceDate} нет заявок для планирования.`, 404);

  const workers = await loadWorkers(database, organizationId, weekdayForDate(serviceDate));

  const compositions = await loadOrderCompositions(database, organizationId);
  for (const row of rows) if (compositions.get(row.id)!.components.some(item=>item.isEmergency)) {
    const window=emergencyWindow(row.scheduled_start,row.scheduling_timezone);
    row.client_window_start=window.windowStart;row.client_window_end=window.windowEnd;row.priority="high";
  }
  const { readyRows, excluded } = await resolveMissingCoordinates(rows);
  const competencies = await listWorkerCompetencies(database, organizationId);
  const planningSettings = await loadPlanningSettings(database);
  const providers = selectPlanningProviders(planningSettings, env.TWO_GIS_API_KEY?.trim() ?? "", {
    drivingUrl: env.OSRM_BASE_URL, walkingUrl: env.OSRM_WALKING_BASE_URL, cyclingUrl:env.OSRM_CYCLING_BASE_URL,
  }, { url: env.OPTIMIZER_SERVICE_URL, token: env.OPTIMIZER_SERVICE_TOKEN });
  const unsupportedWorkers = workers.filter((worker) => !isWorkerTransportSupported(worker.transport_mode, planningSettings));
  if (unsupportedWorkers.length) providers.warnings.push(`В выбранном режиме общественный транспорт не поддерживается. Не участвуют: ${unsupportedWorkers.map((worker) => worker.full_name).join(", ")}. Для их включения выберите PyVRP или OR-Tools и подходящий источник расстояний.`);
  const baseAgents = workers.filter((worker) => !unsupportedWorkers.includes(worker)).map((worker) =>
    toPlanningAgent(worker, serviceDate, workerTravelProfile(worker.transport_mode, planningSettings)));
  const qualifiedAgents = baseAgents.map(agent => ({ ...agent, skills: [...agent.skills, ...(competencies.get(agent.id) ?? []).map(item => `hd:${item.categoryId}:${item.workTypeId}`)] }));
  const horizon=qualifiedAgents.length ? planningHorizon(qualifiedAgents) : {
    startAt: regionalTimeToInstant(`${serviceDate}T00:00`, department!.timezone),
    endAt: regionalTimeToInstant(`${new Date(Date.parse(serviceDate)+86_400_000).toISOString().slice(0,10)}T00:00`, department!.timezone),
  };
  // An empty time means the full selected service day, including today's
  // earlier shift hours. Only an explicit event time truncates the day.
  const planningAt=eventAt ?? horizon.startAt;
  const availability=await availableAgents(database,organizationId,qualifiedAgents,planningAt);
  const equipment = await departmentEquipment(database,organizationId);
  const agents=availability.agents.map(agent => {
    const stock=equipment.get(agent.id)?.[serviceDate];
    return stock ? {...agent,availableEquipmentIds:(stock.items ?? []).map(item=>item.equipmentId)} : agent;
  });
  providers.warnings.push(...availability.warnings);
  const jobs = readyRows.map(row => {
    const composition = compositions.get(row.id)!;
    row.work_name = composition.components.map(item => item.name).join(" + ");
    row.planned_duration_minutes = composition.duration;
    const job = toPlanningJob(row);
    const isEmergency=composition.components.some(item => item.isEmergency);
    const createdInDay=Number.isFinite(Date.parse(row.created_at)) && instantToRegionalTime(row.created_at,row.scheduling_timezone).slice(0,10)===serviceDate;
    return { ...job, isEmergency, requiredEquipmentIds:composition.equipment.map(item=>item.equipmentId), ...(isEmergency ? {releaseAt:new Date(Math.max(Date.parse(planningAt),createdInDay?Date.parse(row.created_at):0)).toISOString()} : {}), requiredSkills: [...new Set(composition.components.flatMap(item => [
      ...(composition.categoryId ? [`hd:${composition.categoryId}:${item.workTypeId}`] : []),
    ]))] };
  });
  const problem: PlanningProblem = {
    id: `planning:${organizationId}:${serviceDate}`,
    horizon,
    profile: { mode: "driving", traffic: "forecast" },
    jobs,
    agents,
    resources: [],
    objectives: ["ortools", "pyvrp"].includes(planningSettings.optimizationEngine) ? optimizerObjectives(planningSettings.optimizerPolicy) : [
      { kind: "minimize_sla_violation", weight: 1 },
      { kind: "maximize_priority_completed", weight: 1 },
      { kind: "minimize_travel_time", weight: 1 },
      { kind: "balance_agent_load", weight: 0.5 },
    ],
  };

  const { matrix, optimizer } = providers;
  const rawProposal: PlanProposal = agents.length ? await optimizer.optimize(problem, { timeoutMs: planningSettings.optimizationEngine === "two_gis_tsp" ? 90_000 : 15_000, traceId: problem.id, ...(signal ? { signal } : {}) })
    : {id:`PROPOSAL-${crypto.randomUUID()}`,problemId:problem.id,status:"ready",routes:[],changes:[],approvals:[],
      unassigned:jobs.map(job=>({jobId:job.id,reason:"unknown",detail:!workers.length ? "В подразделении нет активных исполнителей с рабочей сменой на этот день." : !qualifiedAgents.length ? "Нет исполнителей с поддерживаемым видом транспорта." : "Нет исполнителя с подтверждёнными временем освобождения, местом продолжения маршрута и оставшейся сменой. Уточните доступность в карточке исполнителя."})),
      diagnostics:{engineId:optimizer.engineId,durationMs:0,warnings:[]}};
  const proposal = requireClientVisitApprovals(problem, {...rawProposal,unassigned:rawProposal.unassigned.map(item=>{
    const job=jobs.find(job=>job.id===item.jobId)!;
    const qualified=agents.filter(agent=>job.requiredSkills.every(skill=>agent.skills.includes(skill)));
    if (qualified.length && qualified.every(agent=>agent.availableEquipmentIds !== undefined && job.requiredEquipmentIds.some(id=>!agent.availableEquipmentIds!.includes(id)))) {
      const names=compositions.get(job.id)!.equipment.map(e=>e.name).join(", ");
      return {...item,detail:`Подходящие по компетенциям бригады уже выехали без подтверждённого комплекта: ${names}. Нужна бригада с этим оборудованием или ещё находящаяся в офисе.`};
    }
    return item;
  })});
  const evaluation = evaluatePlan(problem, proposal);
  if (!evaluation.validation.valid) {
    const issueSummary = evaluation.validation.issues.slice(0, 3).map((issue) => issue.message).join(" ");
    throw new PlanningServiceError("INVALID_PLAN", `Validator отклонил план: ${issueSummary}`, 422);
  }

  const [routeGeometry, previousRoutes] = await Promise.all([
    buildRouteGeometry(problem, proposal.routes, providers.routing, signal),
    buildPreviousRoutes(rows, problem, providers.routing, signal),
  ]);

  const planId = `PLAN-${crypto.randomUUID()}`;
  if (await readPlanningInput(database, organizationId) !== inputRevision) throw new PlanningServiceError("INVALID_PLAN", "Данные изменились во время расчёта. Пересчитайте план.", 409);
  const result = buildResult({ planId, serviceDate, problem, proposal, evaluationScore: evaluation.score, workers, rows, excluded, routeGeometry, providerId: matrix.providerId, matrixWarnings: providers.warnings });
  result.planningAt=planningAt;
  result.previousRoutes=previousRoutes;
  result.protectedJobIds=availability.protectedJobs;
  result.metrics.engineersUsed=new Set([...proposal.routes.map(route=>route.agentId),...availability.engagedWorkerIds]).size;
  result.metrics.totalEngineers=new Set([...workers.map(worker=>worker.id),...availability.engagedWorkerIds]).size;
  result.changes = comparePlan(rows, jobs, agents, new Map(workers.map(worker => [worker.id, worker.full_name])), proposal, new Map(result.unassigned.map(item => [item.jobId, item.detail])));
  // Include excluded jobs and previously unassigned client commitments too.
  // The first worker assignment at the unchanged promised time is still silent.
  result.clientApprovals = comparePlan(rows.filter(row => row.client_visit_confirmed).map(row => ({ ...row, had_assignment: 1 })), jobs, agents,
    new Map(workers.map(worker => [worker.id, worker.full_name])), proposal, new Map(result.unassigned.map(item => [item.jobId, item.detail])))
    .filter(change => change.before.workerId || change.before.start !== change.after.start || change.before.end !== change.after.end)
    .map(change => ({ ...change, id: `${planId}:${change.jobId}` }));
  for (const route of result.routes) for (const visit of route.visits) {
    const change = result.changes.find(item => item.jobId === visit.jobId);
    if (change) visit.change = { kind: change.before.workerId !== change.after.workerId ? "reassigned" : "rescheduled",
      label: `${change.before.workerId !== change.after.workerId && change.before.workerName ? `Перенесена с ${change.before.workerName}. ` : ""}${change.before.start !== change.after.start ? `${formatPlanningTime(scheduleTimeToInstant(change.before.start, change.before.timezone), route.timezone)} → ${formatPlanningTime(scheduleTimeToInstant(change.after.start, change.after.timezone), route.timezone)}. ` : ""}${change.reason}`,
      previousAgentName: change.before.workerName, previousStartAt: change.before.start };
    else delete visit.change;
  }
  await saveDraft(database, organizationId, userId, serviceDate, planId, inputRevision, optimizer.engineId, matrix.providerId, proposal.routes, result, writeBatch);
  return result;
}

export async function readSavedPlan(database: D1Database, organizationId: string, serviceDate: string) {
  assertServiceDate(serviceDate);
  const saved = await database.prepare(`SELECT status,result_json,input_revision_json,published_revision_json FROM route_plans
    WHERE organization_id=? AND service_date=? AND status IN ('draft','published') AND result_json IS NOT NULL
    ORDER BY CASE status WHEN 'draft' THEN 0 ELSE 1 END,created_at DESC,rowid DESC LIMIT 1`)
    .bind(organizationId, serviceDate).first<{ status: "draft" | "published"; result_json: string; input_revision_json: string; published_revision_json: string | null }>();
  if (!saved) return { result: null, outdated: false };
  const expected = saved.status === "draft" ? saved.input_revision_json : saved.published_revision_json;
  if (expected !== await readPlanningInput(database, organizationId)) return { result: null, outdated: true };
  return { result: { ...await deserializePlanningResult(saved.result_json), status: saved.status }, outdated: false };
}

export async function publishPlan(database: D1Database, organizationId: string, userId: string, planId: string, clientNotifiedApprovalIds: readonly string[] = [], writeBatch: PlanBatchWriter = statements => database.batch(statements)) {
  const plan = await database.prepare("SELECT id, service_date, status, input_revision_json, result_json FROM route_plans WHERE id = ? AND organization_id = ? LIMIT 1")
    .bind(planId, organizationId).first<{ id: string; service_date: string; status: string; input_revision_json: string | null; result_json: string | null }>();
  if (!plan) throw new PlanningServiceError("NOT_FOUND", "Черновик плана не найден.", 404);
  if (plan.status !== "draft") throw new PlanningServiceError("NOT_FOUND", "Опубликовать можно только актуальный черновик плана.", 409);
  if (!plan.input_revision_json || plan.input_revision_json !== await readPlanningInput(database, organizationId)) throw new PlanningServiceError("INVALID_PLAN", "Заявки или настройки изменились после расчёта. Пересчитайте план.", 409);
  const savedResult = plan.result_json ? await deserializePlanningResult(plan.result_json) : null;
  const requiredApprovals = savedResult?.clientApprovals ?? [];
  if (clientNotifiedApprovalIds.length !== requiredApprovals.length || requiredApprovals.some(item => !clientNotifiedApprovalIds.includes(item.id))) {
    throw new PlanningServiceError("INVALID_PLAN", "Подтвердите сообщение клиенту по каждому изменённому подтверждённому визиту. До этого действует прежний план.", 409);
  }
  const changedStop = await database.prepare(`SELECT 1 FROM route_stops s JOIN work_orders o ON o.id = s.work_order_id
    WHERE s.route_plan_id = ? AND (o.organization_id <> ? OR o.status NOT IN ('new', 'assigned')) LIMIT 1`).bind(planId, organizationId).first();
  if (changedStop) throw new PlanningServiceError("NOT_FOUND", "Статусы заявок изменились: есть начатая, приостановленная или закрытая задача. Пересчитайте план.", 409);

  const stops = await database.prepare(`SELECT work_order_id, worker_id, sequence, planned_start, planned_end, travel_minutes
    FROM route_stops WHERE route_plan_id = ? ORDER BY worker_id, sequence`).bind(planId)
    .all<{ work_order_id: string; worker_id: string; sequence: number; planned_start: string; planned_end: string | null; travel_minutes: number | null }>();
  const orders = await database.prepare(`SELECT id, status, assignee_worker_id, COALESCE(scheduling_timezone, (SELECT timezone FROM organizations WHERE id = work_orders.organization_id)) AS scheduling_timezone FROM work_orders
    WHERE organization_id = ? AND SUBSTR(scheduled_start, 1, 10) = ? AND status IN ('new', 'assigned')`)
    .bind(organizationId, plan.service_date).all<{ id: string; status: "new" | "assigned"; assignee_worker_id: string | null; scheduling_timezone: string }>();
  const availableWorkers = await loadWorkers(database, organizationId, weekdayForDate(plan.service_date));
  const stopByOrderId = new Map(stops.results.map((stop) => [stop.work_order_id, stop]));
  const stopsByWorkerId = new Map<string, typeof stops.results>();
  for (const stop of stops.results) stopsByWorkerId.set(stop.worker_id, [...(stopsByWorkerId.get(stop.worker_id) ?? []), stop]);
  const now = new Date().toISOString();
  const statements: D1PreparedStatement[] = [
    publicationGuard(database, organizationId, userId, planId, now),
    database.prepare("UPDATE route_plans SET status = 'archived', updated_at = ? WHERE organization_id = ? AND service_date = ? AND status = 'published' AND id <> ?")
      .bind(now, organizationId, plan.service_date, planId),
    database.prepare("UPDATE route_plans SET status = 'published', published_by_user_id = ?, published_at = ?, updated_at = ?, result_json = ? WHERE id = ? AND organization_id = ? AND status = 'draft'")
      .bind(userId, now, now, savedResult ? await serializePlanningResult(savedResult) : null, planId, organizationId),
  ];
  for (const order of orders.results) {
    const stop = stopByOrderId.get(order.id);
    if (stop) {
      statements.push(database.prepare(`UPDATE work_orders SET assignee_worker_id = ?,
        resource_id = (SELECT id FROM resources WHERE organization_id = ? AND assigned_worker_id = ?
          AND condition = 'serviceable' AND status IN ('available', 'working') ORDER BY id LIMIT 1),
        scheduled_start = ?, scheduled_end = ?, status = CASE WHEN status = 'new' THEN 'assigned' ELSE status END, updated_at = ?
        WHERE id = ? AND organization_id = ? AND status IN ('new', 'assigned')`)
        .bind(stop.worker_id, organizationId, stop.worker_id, toLocalDateTime(stop.planned_start, order.scheduling_timezone), stop.planned_end ? toLocalDateTime(stop.planned_end, order.scheduling_timezone) : null, now, order.id, organizationId));
      if (order.status === "new") {
        statements.push(database.prepare(`INSERT INTO work_order_status_history
          (id, work_order_id, from_status, to_status, changed_by_user_id, reason, created_at)
          VALUES (?, ?, 'new', 'assigned', ?, 'Публикация плана маршрутов', ?)`)
          .bind(crypto.randomUUID(), order.id, userId, now));
      }
    } else {
      statements.push(database.prepare(`UPDATE work_orders SET assignee_worker_id = NULL, resource_id = NULL,
        status = 'new', updated_at = ? WHERE id = ? AND organization_id = ? AND status IN ('new', 'assigned')`)
        .bind(now, order.id, organizationId));
      if (order.status === "assigned") {
        statements.push(database.prepare(`INSERT INTO work_order_status_history
          (id, work_order_id, from_status, to_status, changed_by_user_id, reason, created_at)
          VALUES (?, ?, 'assigned', 'new', ?, 'Не вошла в опубликованный план', ?)`)
          .bind(crypto.randomUUID(), order.id, userId, now));
      }
    }
  }
  for (const worker of availableWorkers) {
    const workerStops = stopsByWorkerId.get(worker.id) ?? [];
    const serviceMinutes = workerStops.reduce((sum, stop) => sum + intervalMinutes(stop.planned_start, stop.planned_end), 0);
    const travelMinutes = workerStops.reduce((sum, stop) => sum + (stop.travel_minutes ?? 0), 0);
    const availableMinutes = Math.max(1, workdayMinutes(worker));
    const loadPercent = Math.min(100, Math.round((serviceMinutes + travelMinutes) / availableMinutes * 100));
    statements.push(database.prepare("UPDATE workers SET load_percent = ?, updated_at = ? WHERE id = ? AND organization_id = ?")
      .bind(loadPercent, now, worker.id, organizationId));
  }
  const changes = new Map((savedResult?.changes ?? []).map(change => [change.jobId, change]));
  for (const approval of requiredApprovals) changes.set(approval.jobId, approval);
  for (const change of changes.values()) statements.push(schedulingChangeStatement(database, organizationId, change.jobId, userId, "planning",
    change.reason + (requiredApprovals.some(item => item.jobId === change.jobId) ? " Диспетчер подтвердил, что сообщил клиенту." : ""), change.before, change.after, now));
  for (const approval of requiredApprovals) statements.push(database.prepare(`INSERT INTO audit_events
    (id,organization_id,actor_user_id,entity_type,entity_id,action,payload_json,created_at) VALUES (?,?,?,'work_order',?,'client_notified',?,?)`)
    .bind(crypto.randomUUID(), organizationId, userId, approval.jobId, JSON.stringify({ source: "planning", planId, ...approval }), now));
  // Capture the post-publication state inside the same transaction. This allows
  // reloading a saved result without reviving stale routes after a manual edit.
  statements.push(database.prepare(`UPDATE route_plans SET published_revision_json=(SELECT ${planningInputExpression} FROM (SELECT ? AS organization_id) scope) WHERE id=? AND organization_id=?`)
    .bind(organizationId, planId, organizationId));
  statements.push(database.prepare(`INSERT INTO audit_events
    (id, organization_id, actor_user_id, entity_type, entity_id, action, payload_json, created_at)
    VALUES (?, ?, ?, 'route_plan', ?, 'published', ?, ?)`)
    .bind(crypto.randomUUID(), organizationId, userId, planId, JSON.stringify({ serviceDate: plan.service_date, plannedJobs: stops.results.length, unassignedJobs: orders.results.length - stops.results.length }), now));
  try { await writeBatch(statements); }
  catch (error) {
    if (String(error).includes("mobile_command_precondition")) throw new PlanningServiceError("INVALID_PLAN", "Данные изменились перед публикацией. Пересчитайте план.", 409);
    throw error;
  }
  return { planId, status: "published" as const, serviceDate: plan.service_date, publishedAt: now, plannedJobs: stops.results.length, unassignedJobs: orders.results.length - stops.results.length };
}

function intervalMinutes(startAt: string, endAt: string | null) {
  if (!endAt) return 0;
  return Math.max(0, Math.round((Date.parse(endAt) - Date.parse(startAt)) / 60_000));
}

function workdayMinutes(worker: WorkerRow) {
  const total = clockMinutes(worker.work_end) - clockMinutes(worker.work_start);
  const breakMinutes = worker.break_start && worker.break_end ? Math.max(0, clockMinutes(worker.break_end) - clockMinutes(worker.break_start)) : 0;
  return Math.max(0, total - breakMinutes);
}

function clockMinutes(value: string) {
  const [hours = 0, minutes = 0] = value.split(":").map(Number);
  return hours * 60 + minutes;
}

function toLocalDateTime(value: string, timezone: string) {
  return instantToRegionalTime(value, timezone).slice(0, 16);
}

async function loadJobs(database: D1Database, organizationId: string, serviceDate: string): Promise<JobRow[]> {
  const result = await database.prepare(`SELECT work_orders.id, work_orders.number, work_orders.work_type_version_id,work_orders.created_at,work_orders.client_visit_confirmed,
      (SELECT full_name FROM workers WHERE id=work_orders.assignee_worker_id) AS assignee_name,
      CASE WHEN work_orders.assignee_worker_id IS NOT NULL OR EXISTS(SELECT 1 FROM work_order_status_history h WHERE h.work_order_id=work_orders.id AND h.to_status='assigned')
        OR EXISTS(SELECT 1 FROM audit_events a WHERE a.entity_id=work_orders.id AND a.entity_type='work_order' AND a.action='scheduling_changed'
          AND (json_extract(a.payload_json,'$.before.workerId') IS NOT NULL OR json_extract(a.payload_json,'$.after.workerId') IS NOT NULL)) THEN 1 ELSE 0 END AS had_assignment,
      COALESCE(work_orders.scheduling_timezone, organizations.timezone) AS scheduling_timezone,
      work_orders.client_window_start, work_orders.client_window_end,
      work_types.name AS work_name, work_orders.status, work_orders.priority, work_orders.scheduled_start,
      work_orders.scheduled_end, work_type_versions.planned_duration_minutes, work_orders.assignee_worker_id,
      NULL AS baseline_sequence, COALESCE(NULLIF(work_orders.building_address, ''), work_orders.address_snapshot) AS address, work_orders.service_object_id,
      COALESCE(work_orders.latitude_snapshot, service_objects.latitude) AS latitude,
      COALESCE(work_orders.longitude_snapshot, service_objects.longitude) AS longitude
    FROM work_orders
    JOIN organizations ON organizations.id = work_orders.organization_id
    JOIN work_type_versions ON work_type_versions.id = work_orders.work_type_version_id
    JOIN work_types ON work_types.id = work_type_versions.work_type_id
    LEFT JOIN service_objects ON service_objects.id = work_orders.service_object_id
    WHERE work_orders.organization_id = ? AND SUBSTR(work_orders.scheduled_start, 1, 10) = ?
      AND work_orders.status IN ('new', 'assigned')
    ORDER BY work_orders.scheduled_start, work_orders.priority DESC, work_orders.number`)
    .bind(organizationId, serviceDate).all<JobRow>();
  const sequenceByWorker = new Map<string, number>();
  return result.results.map((row) => {
    if (!row.assignee_worker_id) return row;
    const sequence = (sequenceByWorker.get(row.assignee_worker_id) ?? 0) + 1;
    sequenceByWorker.set(row.assignee_worker_id, sequence);
    return { ...row, baseline_sequence: sequence };
  });
}

async function loadWorkers(database: D1Database, organizationId: string, weekday: number): Promise<WorkerRow[]> {
  const result = await database.prepare(`SELECT workers.id, workers.full_name, ${WORKER_TRANSPORT_SQL} AS transport_mode, ${WORKER_PLATE_SQL} AS transport_details,
      COALESCE(workers.timezone, organizations.timezone) AS timezone,
      CASE WHEN TRIM(workers.start_address) = '' THEN organizations.office_address ELSE workers.start_address END AS start_address,
      CASE WHEN TRIM(workers.start_address) = '' THEN organizations.office_latitude ELSE workers.start_latitude END AS start_latitude,
      CASE WHEN TRIM(workers.start_address) = '' THEN organizations.office_longitude ELSE workers.start_longitude END AS start_longitude,
      work_schedules.name AS schedule_name,
      work_schedule_days.start_time AS work_start, work_schedule_days.end_time AS work_end,
      work_schedule_days.break_start, work_schedule_days.break_end
    FROM workers
    JOIN organizations ON organizations.id = workers.organization_id
    JOIN work_schedules ON work_schedules.id = workers.work_schedule_id AND work_schedules.active = 1
    JOIN work_schedule_days ON work_schedule_days.schedule_id = work_schedules.id AND work_schedule_days.weekday = ? AND work_schedule_days.enabled = 1
    WHERE workers.organization_id = ? AND workers.active = 1 AND workers.shift_status IN ('on_shift', 'break')
    ORDER BY workers.full_name`)
    .bind(weekday, organizationId).all<WorkerRow>();
  return result.results;
}

async function resolveMissingCoordinates(rows: JobRow[]) {
  const readyRows: JobRow[] = [];
  const excluded: ExcludedJob[] = [];
  for (const row of rows) {
    if (!row.client_window_start || !row.client_window_end) {
      excluded.push({ row, code: "missing_client_window", reason: "Не задано клиентское окно. Укажите время, когда можно начать работы." });
      continue;
    }
    if (isCoordinate(row.latitude, -90, 90) && isCoordinate(row.longitude, -180, 180)) {
      readyRows.push(row);
      continue;
    }
    try {
      const geocoded = await geocodeAddress(row.address);
      row.latitude = geocoded.point.lat;
      row.longitude = geocoded.point.lon;
      readyRows.push(row);
    } catch (error) {
      const reason = error instanceof GeocodingError ? error.message : "Не удалось получить координаты адреса.";
      excluded.push({ row, code: "geocoding_failed", reason });
    }
  }
  return { readyRows, excluded };
}

function toPlanningJob(row: JobRow): PlanningJob {
  const scheduledStart = scheduleTimeToInstant(row.scheduled_start, row.scheduling_timezone);
  const plannedDurationMinutes = isPlannedDurationMinutes(row.planned_duration_minutes) ? row.planned_duration_minutes : DEFAULT_PLANNED_DURATION_MINUTES;
  const fallbackEnd = addMinutesToTimestamp(row.scheduled_start, plannedDurationMinutes);
  const scheduledEnd = scheduleTimeToInstant(row.scheduled_end ?? fallbackEnd ?? row.scheduled_start, row.scheduling_timezone);
  const serviceDurationSeconds = plannedDurationMinutes * 60;
  return {
    id: row.id,
    location: { lat: row.latitude!, lon: row.longitude! },
    serviceDurationSeconds,
    state: row.client_visit_confirmed ? "client_confirmed" : row.status === "new" ? "new" : "planned",
    changePolicy: row.client_visit_confirmed ? "dispatcher_approval_required" : "free",
    hardTimeWindows: [{ startAt: row.client_window_start!, endAt: row.client_window_end! }],
    softTimeWindows: row.assignee_worker_id ? [{ startAt: scheduledStart, endAt: scheduledStart, penaltyPerMinute: 2 }] : [],
    requiredSkills: [],
    priority: priorityValue(row.priority),
    dropPenalty: priorityValue(row.priority) * 100,
    ...(row.assignee_worker_id && row.baseline_sequence ? { baseline: {
      agentId: row.assignee_worker_id,
      arrivalAt: scheduledStart,
      serviceStartAt: scheduledStart,
      serviceEndAt: scheduledEnd,
      sequence: row.baseline_sequence,
    } } : {}),
  };
}

function toPlanningAgent(
  worker: WorkerRow,
  serviceDate: string,
  travelProfile: TravelProfile,
): PlanningAgent {
  return {
    id: worker.id,
    skills: [],
    fixedResourceTags: [],
    travelProfile,
    shifts: [{
      id: `SHIFT-${worker.id}-${serviceDate}`,
      window: { startAt: regionalTimeToInstant(`${serviceDate}T${clockWithSeconds(worker.work_start)}`, worker.timezone), endAt: regionalTimeToInstant(`${serviceDate}T${clockWithSeconds(worker.work_end)}`, worker.timezone) },
      breaks: worker.break_start && worker.break_end ? [{ startAt: regionalTimeToInstant(`${serviceDate}T${clockWithSeconds(worker.break_start)}`, worker.timezone), endAt: regionalTimeToInstant(`${serviceDate}T${clockWithSeconds(worker.break_end)}`, worker.timezone) }] : [],
      startLocation: { lat: worker.start_latitude, lon: worker.start_longitude },
    }],
  };
}

async function saveDraft(
  database: D1Database,
  organizationId: string,
  userId: string,
  serviceDate: string,
  planId: string,
  inputRevision: string,
  optimizerId: string,
  providerId: string,
  routes: ReadonlyArray<{ agentId: string; visits: ReadonlyArray<{ jobId: string; serviceStartAt: string; serviceEndAt: string; travelSecondsFromPrevious: number }> }>,
  result: PlanningResult,
  writeBatch: PlanBatchWriter,
) {
  const now = new Date().toISOString();
  const statements = [
    database.prepare("UPDATE route_plans SET status = 'archived', updated_at = ? WHERE organization_id = ? AND service_date = ? AND status = 'draft'")
      .bind(now, organizationId, serviceDate),
    database.prepare(`INSERT INTO route_plans
      (id, organization_id, service_date, status, optimizer_version, created_by_user_id, created_at, updated_at, input_revision_json, result_json)
      VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?)`)
      .bind(planId, organizationId, serviceDate, `${optimizerId};matrix=${providerId}`, userId, now, now, inputRevision, await serializePlanningResult(result)),
  ];
  const stops = routes.flatMap((route) => route.visits.map((visit, index) => database.prepare(`INSERT INTO route_stops
    (id, route_plan_id, work_order_id, worker_id, sequence, planned_start, planned_end, travel_minutes, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(`STOP-${crypto.randomUUID()}`, planId, visit.jobId, route.agentId, index + 1, visit.serviceStartAt, visit.serviceEndAt, Math.ceil(visit.travelSecondsFromPrevious / 60), now)));
  await writeBatch([...statements, ...stops]);
}

function buildResult(input: {
  planId: string;
  serviceDate: string;
  problem: PlanningProblem;
  proposal: PlanProposal;
  evaluationScore: NormalizedPlanScore;
  workers: WorkerRow[];
  rows: JobRow[];
  excluded: ExcludedJob[];
  routeGeometry: ReadonlyMap<string, { points: GeoPoint[]; source: "2gis" | "osrm" | "fallback"; warning?: string }>;
  providerId: string;
  matrixWarnings: string[];
}): PlanningResult {
  const jobsById = new Map(input.rows.map((row) => [row.id, row]));
  const workersById = new Map(input.workers.map((worker) => [worker.id, worker]));
  const problemJobs = new Map(input.problem.jobs.map((job) => [job.id, job]));
  const routes: PlanningRouteResult[] = input.proposal.routes.map((route) => {
    const worker = workersById.get(route.agentId)!;
    const shift = input.problem.agents.find((agent) => agent.id === route.agentId)!.shifts.find((item) => item.id === route.shiftId)!;
    const shiftSeconds = (Date.parse(shift.window.endAt) - Date.parse(shift.window.startAt)) / 1_000;
    const breakSeconds = (shift.breaks ?? []).reduce((sum, window) => sum + overlapSeconds(window.startAt, window.endAt, shift.window.startAt, shift.window.endAt), 0);
    const availableSeconds = Math.max(1, shiftSeconds - breakSeconds);
    const serviceSeconds = route.visits.reduce((sum, visit) => sum + (problemJobs.get(visit.jobId)?.serviceDurationSeconds ?? 0), 0);
    const geometry = input.routeGeometry.get(route.agentId)!;
    const profile = input.problem.agents.find((agent) => agent.id === route.agentId)!.travelProfile ?? input.problem.profile;
    return {
      agentId: route.agentId,
      agentName: worker.full_name,
      initials: initials(worker.full_name),
      vehicle: vehicleLabel(worker),
      transportMode: profile.mode,
      scheduleName: worker.schedule_name,
      timezone: worker.timezone,
      shiftStartAt: shift.window.startAt,
      shiftEndAt: shift.window.endAt,
      breaks: [...(shift.breaks ?? [])],
      startPoint: shift.startLocation,
      endPoint: shift.endLocation ?? problemJobs.get(route.visits.at(-1)!.jobId)!.location,
      geometry: geometry.points,
      geometrySource: geometry.source,
      loadPercent: Math.min(100, Math.round((serviceSeconds + route.totalTravelSeconds) / availableSeconds * 100)),
      availableMinutes: Math.round(availableSeconds / 60),
      totalTravelMinutes: Math.ceil(route.totalTravelSeconds / 60),
      totalDistanceKm: round(route.totalDistanceMeters / 1_000, 1),
      returnAt: route.endLeg?.arrivalAt ?? null,
      returnTravelMinutes: Math.ceil((route.endLeg?.travelSeconds ?? 0) / 60),
      visits: route.visits.map((visit) => {
        const row = jobsById.get(visit.jobId)!;
        return {
          jobId: visit.jobId,
          label: `${row.work_name} · ${row.number}`,
          address: row.address,
          arrivalAt: visit.arrivalAt,
          serviceStartAt: visit.serviceStartAt,
          serviceEndAt: visit.serviceEndAt,
          travelMinutes: Math.ceil(visit.travelSecondsFromPrevious / 60),
          distanceKm: round(visit.distanceMetersFromPrevious / 1_000, 1),
          point: { lat: row.latitude!, lon: row.longitude! },
        };
      }),
    };
  });
  const unassigned = [
    ...input.proposal.unassigned.map((item): PlanningUnassignedResult => {
      const row = jobsById.get(item.jobId)!;
      return { jobId: item.jobId, label: `${row.work_name} · ${row.number}`, address: row.address, reason: item.reason, detail: item.detail ?? "" };
    }),
    ...input.excluded.map(({ row, code, reason }): PlanningUnassignedResult => ({ jobId: row.id, label: `${row.work_name} · ${row.number}`, address: row.address, reason: code, detail: reason })),
  ];
  const plannedJobs = routes.reduce((sum, route) => sum + route.visits.length, 0);
  return {
    planId: input.planId,
    status: "draft",
    serviceDate: input.serviceDate,
    providerId: input.providerId,
    optimizerId: input.proposal.diagnostics.engineId,
    metrics: {
      totalJobs: input.rows.length,
      plannedJobs,
      unassignedJobs: unassigned.length,
      engineersUsed: routes.length,
      totalEngineers: input.workers.length,
      totalTravelMinutes: Math.ceil(input.evaluationScore.totalTravelSeconds / 60),
      totalDistanceKm: round(input.evaluationScore.totalDistanceMeters / 1_000, 1),
      hardViolations: input.evaluationScore.hardViolations,
      score: normalizedScalarScore(input.evaluationScore),
    },
    routes,
    unassigned,
    warnings: [
      ...input.proposal.diagnostics.warnings,
      ...input.matrixWarnings,
      ...input.excluded.map(({ row, reason }) => `Заявка ${row.number}: ${reason}`),
      ...[...input.routeGeometry.values()].flatMap((item) => item.warning ? [item.warning] : []),
    ],
  };
}

function formatPlanningTime(value: string, timezone: string) {
  return new Intl.DateTimeFormat("ru-RU", { hour: "2-digit", minute: "2-digit", timeZone: timezone }).format(new Date(value));
}

async function buildRouteGeometry(
  problem: PlanningProblem,
  routes: ReadonlyArray<{ agentId: string; shiftId: string; visits: ReadonlyArray<{ jobId: string }> }>,
  adapter: RouteGeometryPort,
  signal?: AbortSignal,
) {
  const jobs = new Map(problem.jobs.map((job) => [job.id, job]));
  const result = new Map<string, { points: GeoPoint[]; source: "2gis" | "osrm" | "fallback"; warning?: string }>();
  await Promise.all(routes.map(async (route) => {
    const agent = problem.agents.find((item) => item.id === route.agentId)!;
    const shift = agent.shifts.find((item) => item.id === route.shiftId)!;
    const stops = [
      { id: `start:${route.agentId}`, point: shift.startLocation },
      ...route.visits.map((visit) => ({ id: visit.jobId, point: jobs.get(visit.jobId)!.location })),
      ...(shift.endLocation ? [{ id: `end:${route.agentId}`, point: shift.endLocation }] : []),
    ];
    try {
      const response = await adapter.buildRoute({
        stops,
        profile: agent.travelProfile ?? problem.profile,
        departureAt: shift.window.startAt,
        alternatives: 1,
      }, { timeoutMs: 15_000, traceId: `${problem.id}:${route.agentId}`, ...(signal ? { signal } : {}) });
      const geometry = response.data[0]?.geometry ?? [];
      if (geometry.length < 2) throw new Error("Routing API не вернул дорожную линию");
      result.set(route.agentId, { points: [...geometry], source: adapter.providerId === "osrm" ? "osrm" : "2gis" });
    } catch (error) {
      const detail = error instanceof ProviderError ? error.message : "неизвестная ошибка Routing API";
      result.set(route.agentId, {
        points: [],
        source: "fallback",
        warning: `Маршрут ${route.agentId}: дорожная линия не показана, ${detail}`,
      });
    }
  }));
  return result;
}

function vehicleLabel(worker: WorkerRow): string {
  const kind = worker.transport_mode === "car" ? "Автомобиль" : "Общественный транспорт + пешком";
  return worker.transport_details ? `${kind} · ${worker.transport_details}` : kind;
}

function clockWithSeconds(value: string): string { return /^\d{2}:\d{2}$/.test(value) ? `${value}:00` : value; }

function weekdayForDate(serviceDate: string): number {
  const day = new Date(`${serviceDate}T12:00:00Z`).getUTCDay();
  return day === 0 ? 7 : day;
}

function planningHorizon(agents: PlanningAgent[]) {
  const windows = agents.flatMap((agent) => agent.shifts.map((shift) => shift.window));
  return {
    startAt: new Date(Math.min(...windows.map((window) => Date.parse(window.startAt)))).toISOString(),
    endAt: new Date(Math.max(...windows.map((window) => Date.parse(window.endAt)))).toISOString(),
  };
}

function assertServiceDate(value: string) {
  const parsed = Date.parse(`${value}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0, 10) !== value) {
    throw new PlanningServiceError("INVALID_DATE", "Дата планирования должна быть в формате YYYY-MM-DD.", 400);
  }
}

function priorityValue(priority: JobRow["priority"]): number {
  return priority === "high" ? 3 : priority === "medium" ? 2 : 1;
}

function normalizedScalarScore(score: NormalizedPlanScore): number {
  return score.hardViolations * 1_000_000_000
    + score.slaViolationSeconds * 100_000
    + score.unassignedPenalty * 1_000
    + score.confirmedVisitChanges * 100
    + score.softWindowPenalty
    + score.overtimeSeconds
    + score.totalTravelSeconds;
}

function initials(name: string): string {
  return name.trim().split(/\s+/u).slice(0, 2).map((part) => part[0]?.toUpperCase()).join("") || "И";
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function overlapSeconds(startAt: string, endAt: string, boundaryStartAt: string, boundaryEndAt: string): number {
  const start = Math.max(Date.parse(startAt), Date.parse(boundaryStartAt));
  const end = Math.min(Date.parse(endAt), Date.parse(boundaryEndAt));
  return Math.max(0, Math.round((end - start) / 1_000));
}

function isCoordinate(value: number | null | undefined, min: number, max: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}

export function planningErrorResponse(error: unknown): { message: string; status: number } | undefined {
  if (error instanceof PlanningServiceError) return { message: error.message, status: error.status };
  if (error instanceof ProviderError) return { message: error.message, status: error.code === "AUTHENTICATION" || error.code === "FORBIDDEN" ? 424 : error.code === "INVALID_REQUEST" ? 400 : 503 };
  return undefined;
}
