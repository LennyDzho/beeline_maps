import {
  ProviderError, type OptimizationEnginePort, type PlanningProblem, type PlanProposal,
  type PlannedAgentRoute, type ProviderRequestOptions, type TravelTimeMatrixPort, type TimeWindow,
} from "@mmi/provider-contracts";
import { buildChanges, jobPointId, scheduleFixedOrder, shiftEndPointId, shiftPointId } from "./route-scheduling.js";

type JsonObject = Record<string, unknown>;

/** TSP owns allocation/order; the shared scheduler enforces local breaks and service durations. */
export class TwoGisOptimizationEngine implements OptimizationEnginePort {
  readonly engineId = "2gis-tsp-vrp/2.0";
  constructor(private readonly apiKey: string, private readonly matrix: TravelTimeMatrixPort, private readonly fetcher: typeof fetch = fetch, private readonly pollMs = 1500) {}

  async optimize(problem: PlanningProblem, options: ProviderRequestOptions = {}): Promise<PlanProposal> {
    if (!problem.jobs.length) return { id: `PROPOSAL-${crypto.randomUUID()}`, problemId: problem.id, status: "ready", routes: [], unassigned: [], changes: [], approvals: [], diagnostics: { engineId: this.engineId, durationMs: 0, warnings: [] } };
    if (!this.apiKey.trim()) throw failure("AUTHENTICATION", "Для оптимизации 2ГИС нужен ключ с доступом к TSP API.");
    if (this.matrix.providerId !== "2gis") throw failure("NOT_SUPPORTED", "Оптимизатор 2ГИС работает только с дорожными данными 2ГИС. Для OSRM выберите PyVRP или OR-Tools.");
    const profiles = new Set(problem.agents.map((agent) => JSON.stringify(agent.travelProfile ?? problem.profile)));
    if (profiles.size !== 1) throw failure("NOT_SUPPORTED", "TSP API 2ГИС использует один вид транспорта на расчёт. Для смешанного состава исполнителей выберите PyVRP или OR-Tools.");
    if (problem.agents.some((agent) => agent.shifts.length !== 1)) throw failure("NOT_SUPPORTED", "В интеграции TSP 2ГИС поддерживается одна смена исполнителя в день.");
    if (problem.jobs.some((job) => job.changePolicy !== "free" || job.requiredResources?.length) || problem.resources.length) throw failure("NOT_SUPPORTED", "Для заявок с блокировками или отдельными ресурсными ограничениями нужен собственный решатель с поддержкой этих ограничений.");
    const profile = problem.agents[0]?.travelProfile ?? problem.profile;
    if (profile.mode === "public_transport") throw failure("NOT_SUPPORTED", "TSP API 2ГИС не поддерживает общественный транспорт. Выберите PyVRP или OR-Tools.");
    const startedAt = Date.now();
    const timeout = AbortSignal.timeout(options.timeoutMs ?? 90_000);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    const jobsByToken = new Map(problem.jobs.map((job, index) => [`job-${index}`, job]));
    const agentsByToken = new Map(problem.agents.map((agent, index) => [`agent-${index}`, agent]));
    const windowString = (window: TimeWindow) => `${new Date(window.startAt).toISOString()}/${new Date(window.endAt).toISOString()}`;
    const depots = [...agentsByToken].flatMap(([id, agent]) => {
      const shift = agent.shifts[0]!;
      return [
        { id: `start-${id}`, point: { ...shift.startLocation, type: "stop" }, service_duration_s: 0, time_window: { hard_time_window: windowString(shift.window) } },
        ...(shift.endLocation && (shift.endLocation.lat !== shift.startLocation.lat || shift.endLocation.lon !== shift.startLocation.lon) ? [{ id: `end-${id}`, point: { ...shift.endLocation, type: "stop" }, service_duration_s: 0, time_window: { hard_time_window: windowString(shift.window) } }] : []),
      ];
    });
    const body = {
      depots,
      waypoints: [...jobsByToken].map(([id, job]) => ({
        id, point: { ...job.location, type: "stop" }, type: "delivery", service_duration_s: job.serviceDurationSeconds,
        depot_ids: [...agentsByToken.keys()].map((agentId) => `start-${agentId}`),
        required_tags: [...job.requiredSkills ?? [],...(job.requiredEquipmentIds ?? []).map(id=>`equipment:${id}`)],
        time_windows: (job.hardTimeWindows.length ? job.hardTimeWindows : [problem.horizon]).map((window) => ({ hard_time_window: windowString(window) })),
        penalties: { drop: Math.max(10_000, (job.dropPenalty ?? job.priority ?? 1) * 1000) },
      })),
      agents: [...agentsByToken].map(([id, agent]) => ({
        id, start_at: `start-${id}`, ...(agent.shifts[0]!.endLocation ? { finish_at: depots.some((depot) => depot.id === `end-${id}`) ? `end-${id}` : `start-${id}` } : {}),
        shifts: [{ id: "shift", hard_time_window: windowString(agent.shifts[0]!.window) }],
        tags: [...agent.skills,...(agent.availableEquipmentIds ?? [...new Set(problem.jobs.flatMap(job=>job.requiredEquipmentIds ?? []))]).map(id=>`equipment:${id}`)], cost: { fixed: 0, hour: 60, km: 1 }, travel_time_multiplier: agent.travelTimeMultiplier ?? 1,
        ...(agent.maxTravelSeconds === undefined ? {} : { max_travel_time: agent.maxTravelSeconds }),
        ...(agent.maxDistanceMeters === undefined ? {} : { max_distance: agent.maxDistanceMeters }),
      })),
      options: {
        routing_type: profile.mode === "cycling" ? "bicycle" : profile.mode,
        route_type: profile.traffic === "disabled" || profile.mode === "walking" ? "shortest" : "statistics",
        date: problem.horizon.startAt.slice(0, 10), time_zone: "UTC", solver_time_limit_s: 5,
      },
    };
    let payload: JsonObject;
    try {
      // Creation is not retried: a lost response may already have started a billable task.
      payload = await this.request("create", { method: "POST", body: JSON.stringify(body), signal });
      if (typeof payload.task_id !== "string" || !payload.task_id) throw failure("BAD_RESPONSE", "2ГИС не вернул номер задачи оптимизации.");
      const taskId = payload.task_id;
      while (object(payload.status)?.status === "Run") {
        await delay(this.pollMs, signal);
        payload = await this.request("status", { method: "GET", signal }, taskId);
      }
    } catch (cause) {
      if (options.signal?.aborted) throw failure("CANCELLED", "Оптимизация 2ГИС отменена.");
      if (timeout.aborted) throw failure("TIMEOUT", "2ГИС не завершил оптимизацию вовремя. Черновик не изменён.");
      if (cause instanceof ProviderError) throw cause;
      throw failure("UNAVAILABLE", "TSP API 2ГИС недоступен. Проверьте подключение и доступ ключа к оптимизации.");
    }
    const status = object(payload.status)?.status;
    const result = object(payload.result);
    if (status === "Fail") {
      const dropped = result && Array.isArray(result.dropped_waypoints) ? object(result.dropped_waypoints[0]) : undefined;
      const reason = typeof dropped?.reason === "string" ? ` Причина 2ГИС: ${dropped.reason.slice(0, 200)}.` : "";
      throw failure("NO_ROUTE", `2ГИС не нашёл допустимого плана. Проверьте точки, графики и требования заявок.${reason}`);
    }
    if ((status !== "Done" && status !== "Partial") || !result || !Array.isArray(result.routes)) throw failure("BAD_RESPONSE", "2ГИС не вернул завершённое решение TSP.");
    const routes: PlannedAgentRoute[] = [];
    const seen = new Set<string>();
    const warnings: string[] = ["Распределение и порядок рассчитаны TSP API 2ГИС. Время визитов проверено и скорректировано с учётом плановой длительности, предпочтительного начала и перерывов."];
    const orders = new Map<string, string[]>();
    for (const value of result.routes) {
      const route = object(value);
      if (!route || typeof route.agent_id !== "string" || !agentsByToken.has(route.agent_id) || !Array.isArray(route.route)) throw failure("BAD_RESPONSE", "2ГИС вернул неизвестного исполнителя или некорректный маршрут.");
      const ids = orders.get(route.agent_id) ?? [];
      for (const item of route.route) {
        const node = object(object(item)?.node);
        if (!node) throw failure("BAD_RESPONSE", "2ГИС вернул некорректную точку маршрута.");
        if (node.type === "depot" || node.type === "agent") continue;
        const token = object(node.value)?.waypoint_id;
        const job = typeof token === "string" ? jobsByToken.get(token) : undefined;
        if (!job || seen.has(job.id)) throw failure("BAD_RESPONSE", "2ГИС вернул неизвестную или повторяющуюся заявку.");
        seen.add(job.id); ids.push(job.id);
      }
      orders.set(route.agent_id, ids);
    }
    const rejected = new Set<string>();
    for (const [token, ids] of orders) {
      if (!ids.length) continue;
      const agent = agentsByToken.get(token)!;
      const shift = agent.shifts[0]!;
      const points = [
        { id: shiftPointId(agent.id, shift.id), point: shift.startLocation },
        ...ids.map((id) => ({ id: jobPointId(id), point: problem.jobs.find((job) => job.id === id)!.location })),
        ...(shift.endLocation ? [{ id: shiftEndPointId(agent.id, shift.id), point: shift.endLocation }] : []),
      ];
      const matrix = await this.matrix.calculate({ origins: points, destinations: points, profile, departureAt: shift.window.startAt }, { ...options, signal });
      let scheduled = scheduleFixedOrder(problem, agent, shift, ids, matrix.data);
      while (!scheduled && ids.length) {
        rejected.add(ids.pop()!);
        scheduled = scheduleFixedOrder(problem, agent, shift, ids, matrix.data);
      }
      if (scheduled) routes.push(scheduled);
    }
    if (rejected.size) warnings.push(`${rejected.size} заявок из решения 2ГИС не поместились после учёта перерывов и времени выполнения; они оставлены в очереди.`);
    const assigned = new Set(routes.flatMap((route) => route.visits.map((visit) => visit.jobId)));
    return {
      id: `PROPOSAL-${crypto.randomUUID()}`, problemId: problem.id, status: "ready", routes,
      unassigned: problem.jobs.filter((job) => !assigned.has(job.id)).map((job) => ({ jobId: job.id,
        reason: rejected.has(job.id) ? "time_window_infeasible" : "excluded_by_objective",
        detail: rejected.has(job.id) ? "После учёта графика и перерывов заявка не помещается в маршрут 2ГИС." : "TSP API 2ГИС не включил заявку в план." })),
      changes: buildChanges(problem.jobs, routes), approvals: [],
      diagnostics: { engineId: this.engineId, durationMs: Date.now() - startedAt, warnings },
    };
  }

  private async request(action: string, init: RequestInit, taskId?: string): Promise<JsonObject> {
    const url = new URL(`https://routing.api.2gis.com/logistics/vrp/2.0/${action}`);
    url.searchParams.set("key", this.apiKey);
    if (taskId) url.searchParams.set("task_id", taskId);
    const response = await this.fetcher(url, { ...init, headers: { Accept: "application/json", "Content-Type": "application/json" }, cache: "no-store" });
    if (!response.ok) throw failure(response.status === 401 || response.status === 403 ? "FORBIDDEN" : response.status === 429 ? "RATE_LIMITED" : response.status === 402 ? "QUOTA_EXHAUSTED" : "UNAVAILABLE",
      `TSP API 2ГИС отклонил запрос (HTTP ${response.status}). ${response.status === 401 || response.status === 403 ? "Проверьте доступ ключа именно к TSP API." : "Проверьте доступность сервиса и параметры расчёта."}`);
    const payload = object(await response.json());
    if (!payload) throw failure("BAD_RESPONSE", "TSP API вернул некорректный ответ.");
    return payload;
  }
}

function object(value: unknown): JsonObject | undefined { return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined; }
function failure(code: ConstructorParameters<typeof ProviderError>[0]["code"], message: string) { return new ProviderError({ code, providerId: "2gis-tsp", message, retryable: code === "UNAVAILABLE" || code === "TIMEOUT" }); }
async function delay(ms: number, signal: AbortSignal) {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
    function abort() { clearTimeout(timer); reject(signal.reason); }
    signal.addEventListener("abort", abort, { once: true });
  });
}
