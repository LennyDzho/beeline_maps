import {
  evaluatePlan, ProviderError, requireClientVisitApprovals,
  type OptimizationEnginePort, type PlanningProblem, type PlanProposal, type PlannedAgentRoute,
  type ProviderRequestOptions, type TravelTimeMatrixPort, type PlanningObjective,
} from "@mmi/provider-contracts";
import { buildChanges, jobPointId, shiftEndPointId, shiftPointId } from "./route-scheduling.js";
import type { OptimizerPolicy } from "../../planning-settings.js";

export type SolverPolicy = OptimizerPolicy;
export type OptimizerServiceConfig = { url?: string | undefined; token?: string | undefined; policy?: SolverPolicy | undefined };

export function optimizerObjectives(policy: SolverPolicy = "emergency_fast/v1"): PlanningObjective[] {
  const response: PlanningObjective = { kind: "minimize_emergency_delay", weight: 1 };
  const staff: PlanningObjective = { kind: "minimize_agents_used", weight: 1 };
  return [{ kind: "maximize_completed", weight: 1 }, { kind: "maximize_emergencies_completed", weight: 1 },
    ...(policy === "emergency_fast/v1" ? [response, staff] : [staff, response]), { kind: "minimize_distance", weight: 1 }];
}
type Cell = number | null;
export type SolverInput = {
  version: 1; engine?: ServiceEngine; policy: SolverPolicy; timeLimitMs: number; horizonSeconds: number;
  jobs: { id: string; serviceSeconds: number; windows: number[][]; releaseAt: number; emergency: boolean; eligibleAgentIds: string[]; fixed?: { agentId: string; start: number } }[];
  agents: { id: string; shiftId: string; start: number; end: number; breaks: number[][]; durations: Cell[][]; distances: Cell[][]; alreadyEngaged?: boolean; maxJobs?: number; maxTravelSeconds?: number; maxDistanceMeters?: number }[];
};
type SolverOutput = { version: number; engine?: string; policy: string; status: string; solverVersion: string; routes: { agentId: string; shiftId: string; end: number; visits: { jobId: string; start: number; arrival: number }[] }[]; unassigned: string[] };

/** Shared private solver transport. The app owns roads, approvals and final validation. */
export type ServiceEngine = "ortools" | "pyvrp";
export class ServiceOptimizationEngine implements OptimizationEnginePort {
  readonly engineId: string;
  constructor(private readonly kind: ServiceEngine, private readonly label: string, private readonly matrix: TravelTimeMatrixPort, private readonly config: OptimizerServiceConfig = {}, private readonly fetcher: typeof fetch = fetch) {
    this.engineId = `${kind}-routing/application-v1`;
  }

  async optimize(problem: PlanningProblem, options: ProviderRequestOptions = {}): Promise<PlanProposal> {
    const began = Date.now();
    if (!problem.jobs.length) return { id: `PROPOSAL-${crypto.randomUUID()}`, problemId: problem.id, status: "ready", routes: [], unassigned: [], changes: [], approvals: [], diagnostics: { engineId: this.engineId, durationMs: 0, warnings: [] } };
    const endpoint = serviceEndpoint(this.config);
    if (!problem.agents.length || problem.agents.some(a => a.shifts.length !== 1)) throw failure("NOT_SUPPORTED", "Для оптимизатора нужна одна доступная смена каждого исполнителя в выбранном дне.");
    if (problem.resources.length || problem.jobs.some(j => j.requiredResources?.length)) throw failure("NOT_SUPPORTED", "В этом адаптере ещё не поддерживаются ограничения общего пула ресурсов.");
    const input = await buildSolverInput(problem, this.matrix, this.config.policy ?? "emergency_fast/v1", options);
    input.engine = this.kind;
    const timeout = AbortSignal.timeout(input.timeLimitMs + 20_000);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    let output: SolverOutput;
    try {
      // workerd supports manual/follow only. Keep redirects disabled so the
      // private solver token is never forwarded to another endpoint.
      const response = await this.fetcher(endpoint, { method: "POST", signal, redirect: "manual",
        headers: { "Content-Type": "application/json", ...(this.config.token ? { Authorization: `Bearer ${this.config.token}` } : {}) }, body: JSON.stringify(input) });
      if (!response.ok) throw failure(response.status === 401 ? "AUTHENTICATION" : response.status === 422 ? "INVALID_REQUEST" : response.status === 504 ? "TIMEOUT" : "UNAVAILABLE",
        response.status === 422 ? `Сервис ${this.label} отклонил модель ограничений. Черновик не изменён.` : `Сервис ${this.label} недоступен (HTTP ${response.status}). Черновик не изменён.`);
      const source = await response.text();
      if (source.length > 2_000_000) throw failure("BAD_RESPONSE", "Сервис решателя вернул слишком большой ответ.");
      output = parseOutput(JSON.parse(source));
    } catch (error) {
      if (options.signal?.aborted) throw failure("CANCELLED", "Расчёт оптимизатора отменён.");
      if (timeout.aborted) throw failure("TIMEOUT", "Сервис оптимизатора не завершил расчёт вовремя. Черновик не изменён.");
      if (error instanceof ProviderError) throw error;
      throw failure("UNAVAILABLE", "Не удалось получить корректный ответ оптимизатора. Проверьте подключение сервиса.");
    }
    if (output.engine !== this.kind && !(this.kind === "ortools" && output.engine === undefined)) throw failure("BAD_RESPONSE", "Сервис вернул результат другого метода оптимизации.");
    if (output.status === "no_solution_found") throw failure("TIMEOUT", `За отведённое время ${this.label} не нашёл допустимый план. Это не доказательство невыполнимости; прежний черновик сохранён.`);
    if (output.policy !== input.policy) throw failure("BAD_RESPONSE", "Решатель использовал другую политику целей.");
    const routes = restoreRoutes(problem, input, output);
    const proposal: PlanProposal = { id: `PROPOSAL-${crypto.randomUUID()}`, problemId: problem.id, status: "ready", routes,
      unassigned: output.unassigned.map(jobId => {
        const job = input.jobs.find(j => j.id === jobId);
        if (!job) throw failure("BAD_RESPONSE", "Решатель вернул неизвестную заявку.");
        return job.eligibleAgentIds.length ? { jobId, reason: "unknown", detail: "В найденном плане нет допустимого места с учётом клиентского окна, длительности работ, дороги и смен. Поиск ограничен по времени; попробуйте увеличить доступный ресурс или изменить окно." }
          : { jobId, reason: "no_qualified_agent", detail: "Нет доступного исполнителя со всеми обязательными HD, навыками, допусками и необходимым оборудованием после выезда." };
      }), changes: buildChanges(problem.jobs, routes), approvals: [],
      diagnostics: { engineId: `${this.engineId};${this.kind}=${output.solverVersion};policy=${input.policy}`, durationMs: Date.now() - began,
        warnings: [...(this.kind === "pyvrp" ? ["PyVRP: поиск маршрутов и адаптер расписания с улучшением времени начала аварий; поиск ограничен по времени."] : []), input.policy === "emergency_fast/v1" ? "Цели: максимум выполненных заявок → максимум аварий → раннее начало аварий → минимум исполнителей → пробег." : "Цели: максимум выполненных заявок → максимум аварий → минимум исполнителей → раннее начало аварий → пробег.", "Поиск ограничен по времени; глобальная оптимальность не подтверждена."],
        objectiveValues: { assignedJobs: routes.reduce((sum,r) => sum+r.visits.length,0), engineersUsed: new Set(routes.map(r => r.agentId)).size, distanceMeters: routes.reduce((sum,r) => sum+r.totalDistanceMeters,0) } },
    };
    const pending = requireClientVisitApprovals(problem, proposal);
    const validation = evaluatePlan(problem, pending).validation;
    if (!validation.valid) throw failure("BAD_RESPONSE", `Проверка отклонила результат оптимизатора: ${validation.issues.slice(0,3).map(i => i.message).join(" ")}`);
    return pending;
  }
}

export async function buildSolverInput(problem: PlanningProblem, matrix: TravelTimeMatrixPort, policy: SolverPolicy, options: ProviderRequestOptions): Promise<SolverInput> {
  const base = Date.parse(problem.horizon.startAt), end = Date.parse(problem.horizon.endAt);
  if (!Number.isFinite(base) || !Number.isFinite(end) || end <= base || end-base > 7*86400000) throw failure("INVALID_REQUEST", "Некорректный горизонт расчёта.");
  const horizon = Math.floor((end-base)/1000);
  const seconds = (value: string, upper = false) => {
    const offset = (Date.parse(value)-base)/1000;
    if (!Number.isFinite(offset)) throw failure("INVALID_REQUEST", "Некорректное время во входных данных.");
    return upper ? Math.floor(offset) : Math.ceil(offset);
  };
  const jobs: SolverInput["jobs"] = problem.jobs.map(j => ({ id: j.id, serviceSeconds: Math.ceil(j.serviceDurationSeconds),
    windows: (j.hardTimeWindows.length ? j.hardTimeWindows : [problem.horizon]).map(w => [Math.max(0,seconds(w.startAt)),Math.min(horizon,seconds(w.endAt,true))]).filter(w => w[0]! <= w[1]!),
    emergency: j.isEmergency ?? false, releaseAt: Math.max(0,Math.min(horizon,seconds(j.releaseAt ?? problem.horizon.startAt))),
    eligibleAgentIds: problem.agents.filter(a => (j.requiredSkills ?? []).every(s => a.skills.includes(s))
      && (a.availableEquipmentIds === undefined || (j.requiredEquipmentIds ?? []).every(id => a.availableEquipmentIds!.includes(id)))).map(a => a.id),
    ...(j.changePolicy === "immutable" && j.baseline ? { fixed: { agentId: j.baseline.agentId, start: seconds(j.baseline.serviceStartAt) } } : {}),
  }));
  if (problem.jobs.some(j => j.changePolicy === "immutable" && !j.baseline)) throw failure("INVALID_REQUEST", "Неизменяемая заявка не содержит исходного назначения.");
  const agents: SolverInput["agents"] = [];
  const n = jobs.length;
  for (const agent of problem.agents) {
    const shift = agent.shifts[0]!;
    const eligible = problem.jobs.filter((_,i) => jobs[i]!.eligibleAgentIds.includes(agent.id));
    const points = [ ...eligible.map(j => ({ id: jobPointId(j.id), point: j.location })), { id: shiftPointId(agent.id,shift.id), point: shift.startLocation },
      ...(shift.endLocation ? [{ id: shiftEndPointId(agent.id,shift.id), point: shift.endLocation }] : []) ];
    const result = eligible.length ? (await matrix.calculate({ origins: points, destinations: points, profile: agent.travelProfile ?? problem.profile, departureAt: shift.window.startAt }, options)).data : null;
    const cells = new Map(result?.cells.map(cell => [JSON.stringify([cell.originId,cell.destinationId]),cell]));
    const ids = [...problem.jobs.map(j => jobPointId(j.id)), shiftPointId(agent.id,shift.id), shiftEndPointId(agent.id,shift.id)];
    const durations: Cell[][] = ids.map(() => ids.map(() => null));
    const distances: Cell[][] = ids.map(() => ids.map(() => null));
    ids.forEach((from,i) => ids.forEach((to,k) => {
      if (i === k || (k === n+1 && (!shift.endLocation || i === n))) { durations[i]![k]=0; distances[i]![k]=0; return; }
      const cell = cells.get(JSON.stringify([from,to]));
      if (cell?.status === "ok") {
        const duration = Math.ceil(cell.durationSeconds*(agent.travelTimeMultiplier ?? 1)), distance = Math.ceil(cell.distanceMeters);
        if (!Number.isFinite(duration) || !Number.isFinite(distance) || duration < 0 || distance < 0) throw failure("BAD_RESPONSE", "Картографический сервис вернул некорректную матрицу.");
        durations[i]![k]=duration; distances[i]![k]=distance;
      }
    }));
    agents.push({ id: agent.id, shiftId: shift.id, alreadyEngaged:agent.alreadyEngaged ?? false,start: seconds(shift.window.startAt), end: seconds(shift.window.endAt,true),
      breaks: (shift.breaks ?? []).map(w => [Math.max(0,seconds(w.startAt)),Math.min(horizon,seconds(w.endAt,true))]).filter(w => w[0]! < w[1]!), durations, distances,
      ...(agent.maxJobs === undefined ? {} : {maxJobs:agent.maxJobs}), ...(agent.maxTravelSeconds === undefined ? {} : {maxTravelSeconds:Math.floor(agent.maxTravelSeconds)}), ...(agent.maxDistanceMeters === undefined ? {} : {maxDistanceMeters:Math.floor(agent.maxDistanceMeters)}) });
  }
  return { version:1, policy, timeLimitMs: Math.max(100,Math.min(60000,options.timeoutMs ?? 15000)), horizonSeconds:horizon, jobs, agents };
}

export function restoreRoutes(problem: PlanningProblem, input: SolverInput, output: SolverOutput): PlannedAgentRoute[] {
  const base = Date.parse(problem.horizon.startAt), n = input.jobs.length;
  const timestamp = (seconds: number) => new Date(base+seconds*1000).toISOString();
  const metric = (matrix: Cell[][], from: number, to: number) => {
    const value = matrix[from]?.[to];
    if (value === null || value === undefined) throw failure("BAD_RESPONSE", "Решатель использовал недостижимый переход.");
    return value;
  };
  return output.routes.map(r => {
    const agent = input.agents.find(a => a.id === r.agentId && a.shiftId === r.shiftId);
    if (!agent || !r.visits.length) throw failure("BAD_RESPONSE", "Решатель вернул неизвестный или пустой маршрут.");
    let previous = n, travelTotal=0, distanceTotal=0;
    const visits = r.visits.map(v => {
      const index = input.jobs.findIndex(j => j.id === v.jobId);
      if (index < 0) throw failure("BAD_RESPONSE", "Решатель вернул неизвестную заявку.");
      const travel = metric(agent.durations,previous,index), distance = metric(agent.distances,previous,index);
      previous=index; travelTotal+=travel; distanceTotal+=distance;
      return { jobId:v.jobId, arrivalAt:timestamp(v.arrival), serviceStartAt:timestamp(v.start), serviceEndAt:timestamp(v.start+input.jobs[index]!.serviceSeconds), travelSecondsFromPrevious:travel, distanceMetersFromPrevious:distance };
    });
    const shift = problem.agents.find(a => a.id === agent.id)!.shifts[0]!;
    const travel = shift.endLocation ? metric(agent.durations,previous,n+1) : 0;
    const distance = shift.endLocation ? metric(agent.distances,previous,n+1) : 0;
    return { agentId:agent.id, shiftId:agent.shiftId, visits, totalTravelSeconds:travelTotal+travel, totalDistanceMeters:distanceTotal+distance,
      ...(shift.endLocation ? {endLeg:{departureAt:timestamp(r.end-travel),arrivalAt:timestamp(r.end),travelSeconds:travel,distanceMeters:distance}} : {}) };
  });
}

function serviceEndpoint(config: OptimizerServiceConfig) {
  let url: URL;
  try { url = new URL(config.url ?? ""); } catch { throw failure("UNAVAILABLE", "Не настроен сервис оптимизатора. Укажите OPTIMIZER_SERVICE_URL на сервере приложения."); }
  const local = ["localhost","127.0.0.1","[::1]"].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || (url.protocol !== "https:" && !(local && url.protocol === "http:"))) throw failure("INVALID_REQUEST", "Для сервиса оптимизатора нужен HTTPS; HTTP разрешён только на локальном компьютере.");
  if (!local && !config.token?.trim()) throw failure("AUTHENTICATION", "Не настроен токен доступа к сервису оптимизатора.");
  return new URL("v1/solve", `${url.toString().replace(/\/$/u, "")}/`).toString();
}

function parseOutput(value: unknown): SolverOutput {
  const object = (v: unknown): v is Record<string,unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);
  const integer = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v>=0 && v<=7*86400;
  if (!object(value) || value.version !== 1 || !["feasible","no_solution_found"].includes(String(value.status)) || typeof value.policy !== "string" || !Array.isArray(value.routes) || !Array.isArray(value.unassigned)
    || value.unassigned.some(id => typeof id !== "string") || value.routes.some(r => !object(r) || typeof r.agentId !== "string" || typeof r.shiftId !== "string" || !integer(r.end) || !Array.isArray(r.visits)
      || r.visits.some(v => !object(v) || typeof v.jobId !== "string" || !integer(v.start) || !integer(v.arrival)))) throw failure("BAD_RESPONSE", "Неверный формат результата оптимизатора.");
  if (value.status === "feasible" && (typeof value.solverVersion !== "string" || !/^\d+(\.\d+)+$/u.test(value.solverVersion))) throw failure("BAD_RESPONSE", "Не указана версия оптимизатора.");
  return value as unknown as SolverOutput;
}
function failure(code: ConstructorParameters<typeof ProviderError>[0]["code"], message: string) { return new ProviderError({code,message,providerId:"optimizer-service",retryable:code === "UNAVAILABLE" || code === "TIMEOUT"}); }
