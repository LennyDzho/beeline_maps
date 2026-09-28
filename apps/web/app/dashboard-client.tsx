"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AuthUser } from "@/auth/session";
import MaterialIcon from "./components/material-icon";
import { appendPausedVisits } from "./dispatcher/paused-visits";
import { appendProtectedVisits } from "./dispatcher/protected-visits";
import { includeUnroutedEngineers } from "./dispatcher/unrouted-engineers";
import { appendRemovedAssignments } from "./dispatcher/plan-comparison";
import EngineerPanel from "./dispatcher/engineer-panel";
import PlanningMap from "./dispatcher/planning-map";
import { assignedMapRoutes, type MapRoute } from "./dispatcher/assigned-routes";
import RouteComparison from "./dispatcher/route-comparison";
import { findServiceConflicts } from "./lib/scheduling-changes";
import type { PlanningResult } from "./dispatcher/planning-types";
import ClientApprovals from "./dispatcher/client-approvals";
import { equipmentWarning } from "./lib/brigade-equipment";
import DispatcherSectionShell from "./dispatcher/section-shell";
import { apiRequest } from "./lib/api-client";
import { DEFAULT_CALCULATION_TIMEOUT_SECONDS, OPTIMIZATION_ENGINE_OPTIONS, travelSourceLabel, type PlanningSettings } from "./lib/planning-settings";
import RequestEditor, { type RequestEngineer, type RequestItem, type RequestWorkType } from "./requests/request-editor";

import EquipmentReportDialog from "./dispatcher/equipment-report-dialog";
import { instantToRegionalTime } from "./lib/regional-time";

type Department = {id:string;name:string;timezone:string};

export default function DispatcherDashboard({ user }: { user: AuthUser }) {
  const [equipmentOpen, setEquipmentOpen] = useState(false);
  const [workspaceExpanded, setWorkspaceExpanded] = useState(false);
  const workspaceToggleRef = useRef<HTMLButtonElement>(null);
  const closeEquipment = useCallback(() => setEquipmentOpen(false), []);
  const [recalculating, setRecalculating] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [planningResult, setPlanningResult] = useState<PlanningResult | null>(null);
  const [viewingSavedPlan, setViewingSavedPlan] = useState(false);
  // Leaving a day discards its proposal in this view. Only a new explicit
  // calculation can re-enable a draft; polling must not resurrect it.
  const draftViewRef = useRef<string | null>("initial");
  const [clientApprovalIds, setClientApprovalIds] = useState<string[]>([]);
  const requiredClientApprovals = planningResult?.clientApprovals ?? [];
  const pendingClientApprovals = requiredClientApprovals.some(item => !clientApprovalIds.includes(item.id));
  const [serviceDate, setServiceDate] = useState("2026-08-20");
  const [planningTime,setPlanningTime]=useState("");
  const [globalPlanningSettings,setGlobalPlanningSettings]=useState<import("./lib/planning-settings").PlanningSettings | null>(null);
  const [departments,setDepartments]=useState<Department[]>([]);
  const [selectedDepartment,setSelectedDepartment]=useState("all");
  const [selectedEngineer, setSelectedEngineer] = useState("all");
  const [zoom, setZoom] = useState(12);
  const [showPreviousRoutes,setShowPreviousRoutes]=useState(false);
  const [planningRequests, setPlanningRequests] = useState<Record<string, RequestItem>>({});
  const [editingRequest, setEditingRequest] = useState<RequestItem | null>(null);
  useEffect(() => {
    if (!workspaceExpanded || editingRequest || equipmentOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      setWorkspaceExpanded(false);
      workspaceToggleRef.current?.focus();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [workspaceExpanded, editingRequest, equipmentOpen]);
  const [notice, setNotice] = useState("");
  const [calculationSeconds, setCalculationSeconds] = useState(0);
  const [calculationLimit, setCalculationLimit] = useState(DEFAULT_CALCULATION_TIMEOUT_SECONDS);
  useEffect(() => {
    if (!recalculating) return;
    const started = Date.now();
    const timer = window.setInterval(() => setCalculationSeconds(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, [recalculating]);
  const [workCategories, setWorkCategories] = useState<(import("@/app/lib/work-catalog").WorkCategory & {organizationId?:string})[]>([]);
  const [workTypes, setWorkTypes] = useState<RequestWorkType[]>([]);
  const [requestEngineers, setRequestEngineers] = useState<RequestEngineer[]>([]);
  const requestSignatureRef = useRef("");
  const dateInitializedRef = useRef(false);
  const observedMethodsRef = useRef<string | null>(null);
  const [loadingDay, setLoadingDay] = useState(true);

  async function loadRequestData(date?: string, signal?: AbortSignal) {
    return apiRequest<{ planningSettings:PlanningSettings; departments:Department[]; items: RequestItem[]; workTypes: RequestWorkType[]; engineers: RequestEngineer[]; workCategories: (import("@/app/lib/work-catalog").WorkCategory & {organizationId?:string})[] }>(`/api/planning/workspace${date ? `?date=${date}` : ""}`, { signal });
  }

  useEffect(() => {
    const controller = new AbortController();
    let pending = false;
    const reload = async () => {
      if (pending) return;
      pending = true;
      try {
        const [data, saved] = await Promise.all([
          loadRequestData(dateInitializedRef.current ? serviceDate : undefined, controller.signal),
          recalculating || publishing ? Promise.resolve(null) : apiRequest<{ result: PlanningResult | null; outdated: boolean; methodsChanged?: boolean; displayResult?: PlanningResult | null }>(`/api/planning/group?date=${serviceDate}${draftViewRef.current === null ? "&publishedOnly=1" : ""}`, { signal: controller.signal }),
        ]);
        if (controller.signal.aborted) return;
        if (!dateInitializedRef.current) {
          dateInitializedRef.current = true;
          const initialDate = selectPlanningDate(data.items) ?? serviceDate;
          if (initialDate !== serviceDate) {
            setServiceDate(initialDate);
            return;
          }
        }
        const items = data.items.filter(item => item.dateTime.slice(0, 10) === serviceDate);
        const nextSignature = requestSignature(items);
        if (nextSignature !== requestSignatureRef.current) setPlanningResult(null);
        requestSignatureRef.current = nextSignature;
        setPlanningRequests(Object.fromEntries(items.map(item => [item.id, item])));
        setWorkTypes(data.workTypes); setWorkCategories(data.workCategories);
        setDepartments(data.departments); setGlobalPlanningSettings(data.planningSettings);
        // A historical plan may have used other methods. Warn only when the
        // currently observed settings change, never just for opening that day.
        const methods = `${data.planningSettings.optimizationEngine}:${data.planningSettings.travelMatrixProvider}`;
        if (observedMethodsRef.current !== null && observedMethodsRef.current !== methods) {
          setNotice("Метод расчёта расстояний или алгоритм оптимизации изменён. Пересчитайте план.");
        }
        observedMethodsRef.current = methods;
        setSelectedDepartment(current => current === "all" || data.departments.some(d => d.id === current) ? current : "all");
        setRequestEngineers(data.engineers);
        if (saved) {
          const stored = saved.result ?? saved.displayResult;
          const allowedDraft = draftViewRef.current === "initial" || draftViewRef.current === stored?.planId;
          const assignmentsMatch = stored?.status !== "published" || stored.routes.every(route => route.visits.every(visit =>
            items.some(item => item.id === visit.jobId && item.assigneeId === route.agentId && item.status !== "new" && item.status !== "cancelled")));
          const candidate = (stored?.status === "draft" && !allowedDraft) || !assignmentsMatch ? null : stored;
          const currentIds = new Set(items.filter(item => item.status !== 'cancelled').map(item => item.id));
          const matchesDay = candidate?.serviceDate === serviceDate && candidate.routes.every(route => route.visits.every(visit => currentIds.has(visit.jobId))) && candidate.unassigned.every(job => currentIds.has(job.jobId));
          const matchesTime = !planningTime || candidate?.departments?.every(d => !d.planningAt || instantToRegionalTime(d.planningAt,d.timezone).slice(11,16) === planningTime);
          setPlanningResult(matchesDay && matchesTime ? candidate ?? null : null);
          setViewingSavedPlan(Boolean(saved.outdated && candidate && matchesDay && matchesTime));
        }
        setLoadingDay(false);
      } catch (error) {
        if (!controller.signal.aborted) {
          setNotice(error instanceof Error ? error.message : "Не удалось загрузить заявки выбранного дня.");
          setLoadingDay(false);
        }
      } finally { pending = false; }
    };
    void reload();
    const poll = () => { if (!document.hidden) void reload(); };
    const timer = window.setInterval(poll, 15000);
    window.addEventListener("focus", poll);
    return () => { controller.abort(); window.clearInterval(timer); window.removeEventListener("focus", poll); };
  }, [serviceDate, recalculating, publishing, planningTime]);

  const assignmentMarkers = useMemo(() => assignedMapRoutes(Object.values(planningRequests), requestEngineers, serviceDate), [planningRequests, requestEngineers, serviceDate]);
  // Stable across workspace polling and UI filters; changes cancel obsolete geometry requests.
  const assignmentKey = !loadingDay && !planningResult && assignmentMarkers.length && globalPlanningSettings
    ? JSON.stringify([serviceDate, globalPlanningSettings.travelMatrixProvider, assignmentMarkers,
      requestEngineers.map(worker => [worker.id, worker.vehicle]),
      Object.values(planningRequests).map(item => [item.id, item.dateTime, item.schedulingTimezone])]) : "";
  const [assignmentGeometry, setAssignmentGeometry] = useState<{key:string;routes:MapRoute[]} | null>(null);
  useEffect(() => {
    if (!assignmentKey) return;
    const controller = new AbortController();
    void apiRequest<{routes:MapRoute[]}>(`/api/planning/assigned-routes?date=${serviceDate}`, {signal:controller.signal})
      .then(data => { if (!controller.signal.aborted) setAssignmentGeometry({key:assignmentKey,routes:data.routes}); })
      .catch(() => { /* Actual assignment markers remain visible if road geometry is unavailable. */ });
    return () => controller.abort();
  }, [assignmentKey, serviceDate]);
  const mapRoutes = planningResult?.routes ?? (assignmentKey && assignmentGeometry?.key === assignmentKey ? assignmentGeometry.routes : assignmentMarkers);

  const baseEngineers = planningResult
    ? planningResult.routes.map((route, index) => ({
        id: route.agentId,
        initials: route.initials,
        name: route.agentName,
        vehicle: route.vehicle,
        schedule: formatSchedule(route),
        routeSummary: `${route.totalTravelMinutes} мин в пути · ${route.totalDistanceKm} км · ${travelSourceLabel(planningResult.departments?.find(d=>d.workerIds.includes(route.agentId))?.providerId ?? planningResult.providerId)}${route.transportMode === "walking" ? " · пеший расчёт" : ""} · доступно ${route.availableMinutes} мин`,
        load: route.loadPercent,
        accent: (index % 2 === 0 ? "gold" : "violet") as "gold" | "violet",
        visits: [
          ...route.visits.map((visit) => ({
            time: formatTime(visit.serviceStartAt, route.timezone),
            label: `Заявка ${planningRequests[visit.jobId]?.number ?? visit.label}`,
            requestId: visit.jobId,
            travel: visit.travelMinutes ? `${visit.travelMinutes} мин` : undefined,
            change: visit.change,
          })),
          ...(route.returnAt ? [{
            time: formatTime(route.returnAt, route.timezone),
            label: "Возврат в начальную точку",
            travel: route.returnTravelMinutes ? `${route.returnTravelMinutes} мин` : undefined,
            kind: "return" as const,
          }] : []),
        ],
      }))
    : requestEngineers.map((engineer, index) => ({
        id: engineer.id,
        initials: getInitials(engineer.name),
        name: engineer.name,
        vehicle: engineer.vehicle,
        load: Object.values(planningRequests).some(request => request.assigneeId === engineer.id && request.dateTime.startsWith(serviceDate) && request.status !== "cancelled") ? engineer.load : 0,
        accent: (index % 2 === 0 ? "gold" : "violet") as "gold" | "violet",
        visits: Object.values(planningRequests).filter((request) => !["paused","cancelled"].includes(request.status) && request.assigneeId===engineer.id && request.dateTime.slice(0,10)===serviceDate).sort((a, b) => a.dateTime.localeCompare(b.dateTime)).map((request) => ({
          time: request.dateTime.slice(11, 16), label: `Заявка ${request.number ?? "Без номера"}`, requestId: request.id,
        })),
      }));
  const visibleEngineers = planningResult ? includeUnroutedEngineers(baseEngineers, requestEngineers) : baseEngineers;
  const proposedVisits = new Map(planningResult?.routes.flatMap(route=>route.visits.map(visit=>[visit.jobId,{...visit,agentId:route.agentId}] as const)) ?? []);
  const effectiveRequests = Object.values(planningRequests).map(request=>{
    const visit=proposedVisits.get(request.id);
    if (visit) return {...request,assigneeId:visit.agentId,dateTime:visit.serviceStartAt,
      serviceDurationMinutes:(Date.parse(visit.serviceEndAt)-Date.parse(visit.serviceStartAt))/60000};
    return planningResult?.unassigned.some(item=>item.jobId===request.id) ? {...request,assigneeId:undefined} : request;
  });
  const scheduledEngineers = appendRemovedAssignments(appendPausedVisits(appendProtectedVisits(visibleEngineers, Object.values(planningRequests), requestEngineers,serviceDate), Object.values(planningRequests).filter(r => r.dateTime.slice(0, 10) === serviceDate), requestEngineers), planningResult?.changes ?? [])
    .map(engineer=>({...engineer,visits:engineer.visits.map(visit=>{
      const request=effectiveRequests.find(item=>item.id===visit.requestId);
      return {...visit,equipmentWarning:equipmentWarning(planningRequests[visit.requestId ?? ""]?.equipment ?? [],requestEngineers.find(item=>item.id===engineer.id)?.equipmentByDate?.[serviceDate]),
        scheduleConflicts:request ? findServiceConflicts(request,effectiveRequests.filter(item=>item.organizationId===request.organizationId),request.schedulingTimezone || "Europe/Moscow") : []};
    })}));
  const serviceDateRequests = Object.values(planningRequests).filter((request) => request.dateTime.slice(0, 10) === serviceDate && request.status !== "cancelled");
  const assignedForServiceDate = serviceDateRequests.filter((request) => request.status !== "new").length;
  const visibleUnassigned = planningResult?.unassigned ?? serviceDateRequests
    .filter((request) => request.status === "new" && !request.assignee)
    .map((request) => ({
      jobId: request.id,
      label: `${request.work} · ${request.number ?? "Без номера"}`,
      address: request.address,
      reason: "awaiting_assignment",
      detail: "Новая заявка ожидает распределения по исполнителям.",
    }));

  async function calculatePlan(focusAgentId = "all") {
    if (recalculating) return;
    let timeout: AbortSignal | undefined;
    const startingSignature = requestSignatureRef.current;
    setCalculationSeconds(0);
    setRecalculating(true);
    setNotice("");
    try {
      // Refresh global settings before starting so another tab's saved limit
      // cannot leave this browser using the previous shorter timeout.
      const workspace = await apiRequest<{ planningSettings: PlanningSettings }>("/api/planning/workspace", { signal: AbortSignal.timeout(15_000) });
      const limit = workspace.planningSettings.calculationTimeoutSeconds ?? DEFAULT_CALCULATION_TIMEOUT_SECONDS;
      setGlobalPlanningSettings(workspace.planningSettings);
      observedMethodsRef.current = `${workspace.planningSettings.optimizationEngine}:${workspace.planningSettings.travelMatrixProvider}`;
      setCalculationLimit(limit);
      timeout = AbortSignal.timeout((limit + 10) * 1000);
      const data = await apiRequest<{ result: PlanningResult }>("/api/planning/group", {
        method: "POST",
        signal: timeout,
        body: JSON.stringify({ serviceDate, ...(planningTime?{eventTime:planningTime}:{}) }),
      });
      if (startingSignature !== requestSignatureRef.current) throw new Error("Заявки изменились во время расчёта. Нажмите «Пересчитать» ещё раз.");
      draftViewRef.current = data.result.planId;
      setPlanningResult(data.result);
      setViewingSavedPlan(false);
      const focusedRoute = focusAgentId === "all" ? undefined : data.result.routes.find((route) => route.agentId === focusAgentId);
      setSelectedEngineer(focusedRoute ? focusAgentId : "all");
      const assignedFromQueue = data.result.routes.reduce((sum, route) => sum + route.visits.filter((visit) => !planningRequests[visit.jobId]?.assigneeId).length, 0);
      const summary = focusAgentId !== "all" && !focusedRoute
        ? "Для выбранного исполнителя маршрут не построен: проверьте доступность, график и требования заявок."
        : data.result.unassigned.length
          ? `Черновик рассчитан: ${data.result.metrics.plannedJobs} из ${data.result.metrics.totalJobs}. Назначено из очереди: ${assignedFromQueue}. Нераспределено: ${data.result.unassigned.length}.`
          : `Черновик рассчитан и проверен: ${data.result.metrics.plannedJobs} заявок. Назначено из очереди: ${assignedFromQueue}.`;
      const travelSource = !data.result.routes.length ? "" : data.result.providerId.includes(" + ") ? `Источники подразделений: ${travelSourceLabel(data.result.providerId)}.` : data.result.providerId === "2gis"
        ? "Время и расстояния получены из дорожной матрицы 2ГИС."
        : data.result.providerId === "osrm" ? "Время и расстояния получены по дорогам OSRM / OpenStreetMap, без пробок." : "Время и расстояния рассчитаны приблизительно.";
      const missingGeometry = data.result.routes.filter((route) => route.geometrySource === "fallback").length;
      const geometryStatus = missingGeometry
        ? ` Для ${missingGeometry} ${missingGeometry === 1 ? "маршрута" : "маршрутов"} дорожная линия не показана.`
        : data.result.routes.length ? " Дорожные линии маршрутов получены." : "";
      setNotice(`${summary} ${travelSource}${geometryStatus}`);
    } catch (error) {
      setNotice(timeout?.aborted ? "Сервер не ответил за отведённое время. Обновите страницу, чтобы проверить состояние черновика." : error instanceof Error ? error.message : "Не удалось пересчитать план.");
    } finally {
      setRecalculating(false);
    }
  }

  function recalculate() { void calculatePlan(); }

  function selectServiceDate(value: string) {
    if (!isServiceDate(value) || value === serviceDate || recalculating || publishing) return;
    dateInitializedRef.current = true;
    draftViewRef.current = null;
    observedMethodsRef.current = null;
    setLoadingDay(true);
    setPlanningRequests({});
    setSelectedEngineer("all");
    setClientApprovalIds([]);
    setShowPreviousRoutes(false);
    setNotice("");
    setServiceDate(value);
    setPlanningTime("");
    setPlanningResult(null);
    setViewingSavedPlan(false);
  }

  function selectEngineerRoute(id: string) {
    // Selection is display-only, even while an explicit recalculation is running.
    if (selectedEngineer === id) {
      setSelectedEngineer("all");
      return;
    }
    setSelectedEngineer(id);
  }

  async function publish() {
    if (!planningResult || viewingSavedPlan || publishing || pendingClientApprovals) return;
    setPublishing(true);
    try {
      await apiRequest("/api/planning/group", { method: "PUT", body: JSON.stringify({ planId: planningResult.planId, clientNotifiedApprovalIds: requiredClientApprovals.map(item => item.id) }) });
      setPlanningResult((current) => current ? { ...current, status: "published" } : current);
      const data = await loadRequestData(serviceDate);
      requestSignatureRef.current = requestSignature(data.items);
      setPlanningRequests(Object.fromEntries(data.items.map((item) => [item.id, item])));
      setWorkTypes(data.workTypes); setWorkCategories(data.workCategories);
      setRequestEngineers(data.engineers);
      setDepartments(data.departments);
      setNotice(`План на ${formatServiceDate(serviceDate)} опубликован.`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Не удалось опубликовать план.");
    } finally {
      setPublishing(false);
    }
  }

  const workerDepartment=(id:string)=>requestEngineers.find(e=>e.id===id)?.organizationId
    ?? planningRequests[(planningResult?.changes ?? []).find(c=>c.before.workerId===id)?.jobId ?? ""]?.organizationId;
  const shownWorkers=new Set(scheduledEngineers.filter(e=>selectedDepartment==="all" || workerDepartment(e.id)===selectedDepartment).map(e=>e.id));
  const shownJob=(id:string)=>selectedDepartment==="all" || planningRequests[id]?.organizationId===selectedDepartment;
  const shownUnassigned=visibleUnassigned.filter(item=>shownJob(item.jobId));
  const editingDepartment=departments.find(d=>d.id===editingRequest?.organizationId);
  return (
    <DispatcherSectionShell user={user} active="planning" className="planning-shell" planningScope={{departments,selectedId:selectedDepartment,onChange:id=>{setSelectedDepartment(id);setSelectedEngineer("all");}}}>
        <main className={`dispatcher-content${workspaceExpanded ? " workspace-expanded" : ""}`}>
          <section className="planning-heading">
            <div>
              <div className="planning-title-row">
                <h1>Планирование выездов</h1>
                <span className={planningResult?.status ?? "empty"}>{viewingSavedPlan ? "Сохранённый расчёт" : planningResult?.status === "published" ? "План опубликован" : planningResult?.status === "draft" ? "Черновик" : "Нет расчёта"}</span>
              </div>
              <label className="planning-date-picker">
                <span>{formatServiceDate(serviceDate)}</span>
                <input type="date" disabled={recalculating || publishing} value={serviceDate} onInput={(event) => selectServiceDate(event.currentTarget.value)} aria-label="Дата планирования" />
              </label>
              <label className="planning-from-picker"><span>Перепланировать с (местное время каждого подразделения)</span><input type="time" value={planningTime} onChange={event=>{setPlanningTime(event.target.value);setPlanningResult(null);}} aria-label="Время перепланирования" /><small>Пусто — за весь выбранный день. Указано время — с этого времени в выбранном дне.</small></label>
              <p className="planning-tail-note">Расчёт, публикация и сводка охватывают все доступные подразделения ({departments.length}). Фильтр меняет показ маршрутов и уведомлений.</p>
              <p className="planning-tail-note" aria-label="Общий источник расчёта">Метод расчёта: {globalPlanningSettings ? OPTIMIZATION_ENGINE_OPTIONS.find(option => option.id === globalPlanningSettings.optimizationEngine)?.label : "загрузка…"}. Источник времени и расстояний: {globalPlanningSettings ? globalPlanningSettings.travelMatrixProvider==='osrm' ? 'OSRM / OpenStreetMap (без пробок)' : '2ГИС' : 'загрузка…'}.</p>
              {planningResult?.departments?.map(d=>d.planningAt && <small key={d.id}>{d.name}: с {instantToRegionalTime(d.planningAt,d.timezone).slice(11,16)} ({d.timezone}) · {d.metrics.totalDistanceKm.toFixed(1)} км. </small>)}
              {Boolean(planningResult?.protectedJobIds?.length) && <p className="planning-tail-note">Защищено заявок: {planningResult!.protectedJobIds!.length}. Распределение и пробег ниже относятся к оставшейся очереди; число исполнителей включает уже занятых.</p>}
            </div>
            <div className="planning-actions">
              <button className="recalculate-button" type="button" onClick={() => setEquipmentOpen(true)}>Требуемое оборудование</button>
              <button className="recalculate-button" type="button" onClick={recalculate} disabled={loadingDay || recalculating || publishing}>
                <MaterialIcon name="sync" className={recalculating ? "rotating" : ""} />
                {recalculating ? "Расчёт…" : "Пересчитать"}
              </button>
              <button className="stitch-green-button" type="button" onClick={publish} disabled={viewingSavedPlan || loadingDay || recalculating || !planningResult || planningResult.status !== "draft" || publishing || pendingClientApprovals}>
                {planningResult?.status === "published" ? "Опубликовано" : publishing ? "Публикация…" : "Опубликовать план"}
              </button>
            </div>
          </section>

          {loadingDay && <p className="planning-tail-note" role="status">Загрузка заявок на {formatServiceDate(serviceDate)}…</p>}
          {recalculating && <p className="planning-tail-note" role="status">Расчёт выполняется · {calculationSeconds} с. Получаем дорожные расстояния, распределяем заявки и строим линии маршрутов для всех подразделений. Максимальное ожидание — {calculationLimit} с.</p>}

          <section className="stitch-metrics" aria-label="Сводка дня">
            <article><small>Заявки на выбранную дату</small><strong>{planningResult?.metrics.totalJobs ?? serviceDateRequests.length}</strong></article>
            <article><small>Запланировано</small><strong>{planningResult?.metrics.plannedJobs ?? assignedForServiceDate}<span> / {planningResult?.metrics.totalJobs ?? serviceDateRequests.length}</span></strong></article>
            <article><small>Исполнители</small><strong>{planningResult?.metrics.engineersUsed ?? new Set(serviceDateRequests.map(r=>r.assigneeId).filter(Boolean)).size}<span> / {planningResult?.metrics.totalEngineers ?? requestEngineers.length}</span></strong></article>
            <article><small>Время в пути</small><strong className="gold-value">{planningResult ? `${planningResult.metrics.totalTravelMinutes} мин` : "—"}</strong></article>
            <article><small>Суммарный пробег</small><strong>{planningResult ? `${planningResult.metrics.totalDistanceKm.toFixed(1)} км` : "—"}</strong></article>
          </section>

          {planningResult && !viewingSavedPlan && <ClientApprovals plan={planningResult} selected={clientApprovalIds} onChange={setClientApprovalIds} />}
          <RouteComparison before={(planningResult?.previousRoutes ?? []).filter(r=>shownWorkers.has(r.agentId) && (selectedEngineer==="all" || selectedEngineer===r.agentId))}
            after={(planningResult?.routes ?? []).filter(r=>shownWorkers.has(r.agentId) && (selectedEngineer==="all" || selectedEngineer===r.agentId))}
            showPrevious={showPreviousRoutes} onToggle={setShowPreviousRoutes} onOpenRequest={id=>setEditingRequest(planningRequests[id] ?? null)} />
          <section className="dispatcher-workspace" id="planning-workspace" aria-label="Карта и исполнители">
            <EngineerPanel
              viewControl={<button ref={workspaceToggleRef} type="button" className="workspace-view-toggle"
              aria-controls="planning-workspace" aria-expanded={workspaceExpanded}
              title={workspaceExpanded ? "Вернуть шапку планирования (Esc)" : "Скрыть шапку, статистику и примечания"}
              onClick={() => setWorkspaceExpanded(current => !current)}>
              <MaterialIcon name={workspaceExpanded ? "fullscreen_exit" : "fullscreen"} />
              {workspaceExpanded ? "Свернуть рабочую область" : "Развернуть карту и исполнителей"}
              </button>}
              engineers={scheduledEngineers.filter(e=>shownWorkers.has(e.id)).map(e=>({...e,name:`${e.name}${selectedDepartment==="all" ? ` · ${departments.find(d=>d.id===workerDepartment(e.id))?.name ?? ""}` : ""}`}))}
              selectedId={selectedEngineer}
              onSelect={selectEngineerRoute}
              onOpenRequest={(requestId) => setEditingRequest(planningRequests[requestId] ?? null)}
              unassigned={shownUnassigned}
            />
            <PlanningMap
              key={globalPlanningSettings?.travelMatrixProvider ?? "loading"}
              provider={globalPlanningSettings?.travelMatrixProvider}
              zoom={zoom}
              onZoomIn={() => setZoom((value) => Math.min(19, value + 1))}
              onZoomOut={() => setZoom((value) => Math.max(4, value - 1))}
              selectedEngineer={selectedEngineer}
              routes={mapRoutes.filter(route=>shownWorkers.has(route.agentId))}
              previousRoutes={showPreviousRoutes ? (planningResult?.previousRoutes ?? []).filter(route=>shownWorkers.has(route.agentId)) : []}
              unassignedCount={shownUnassigned.length}
            />
          </section>
        </main>
      {equipmentOpen && <EquipmentReportDialog common departmentId={selectedDepartment==="all" ? undefined : selectedDepartment} date={serviceDate} planId={planningResult?.planId} workerId={selectedEngineer === "all" ? undefined : selectedEngineer} onClose={closeEquipment} onOpenRequest={id => { setEquipmentOpen(false); setEditingRequest(planningRequests[id] ?? null); }} />}
      {editingRequest && <RequestEditor otherRequests={Object.values(planningRequests).filter(r=>r.organizationId===editingRequest.organizationId)} workCategories={workCategories}
        initialRequest={editingRequest}
        departmentTimezone={editingDepartment?.timezone}
        workTypes={workTypes}
        engineers={requestEngineers.filter(t=>t.organizationId===editingRequest.organizationId)}
        onClose={() => setEditingRequest(null)}
        onSave={async (request) => {
          try {
            const data = await apiRequest<{ item: RequestItem }>("/api/requests", { method: "PUT", headers: {"X-MMI-Organization":editingRequest.organizationId!}, body: JSON.stringify({ ...request, id: editingRequest.id }) });
            setPlanningRequests((current) => ({ ...current, [editingRequest.id]: {...data.item,organizationId:editingRequest.organizationId} }));
            setPlanningResult(null);
            setNotice(`Заявка #${data.item.number ?? "Без номера"} обновлена.`);
            setEditingRequest(null);
            window.setTimeout(() => setNotice(""), 4000);
          } catch (error) { setNotice(error instanceof Error ? error.message : "Не удалось сохранить заявку."); throw error; }
        }}
      />}
      {notice && <div className="resource-notice" role="status">{notice}</div>}
    </DispatcherSectionShell>
  );
}

function formatTime(value: string, timezone: string) {
  return new Intl.DateTimeFormat("ru-RU", { hour: "2-digit", minute: "2-digit", timeZone: timezone }).format(new Date(value));
}

function requestSignature(items: RequestItem[]) {
  return JSON.stringify(items.map(item => [item.id, item.revision, item.status, item.assigneeId]));
}

function getInitials(name: string) {
  return name.trim().split(/\s+/u).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join("") || "И";
}

function formatServiceDate(value: string) {
  if (!isServiceDate(value)) return "Выберите дату";
  const date = new Date(`${value}T12:00:00+03:00`);
  return new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long", weekday: "long", timeZone: "Europe/Moscow" }).format(date);
}

function isServiceDate(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T12:00:00+03:00`));
}

function formatSchedule(route: PlanningResult["routes"][number]) {
  const shift = `${formatTime(route.shiftStartAt, route.timezone)}–${formatTime(route.shiftEndAt, route.timezone)}`;
  const breaks = route.breaks.map((item) => `${formatTime(item.startAt, route.timezone)}–${formatTime(item.endAt, route.timezone)}`).join(", ");
  return `${route.scheduleName} · ${route.timezone} · ${shift}${breaks ? ` · перерыв ${breaks}` : " · без перерыва"}`;
}

function selectPlanningDate(items: RequestItem[]) {
  const counts = new Map<string, number>();
  for (const item of items) {
    if (item.status !== "new" && item.status !== "assigned") continue;
    const date = item.dateTime.slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(date)) counts.set(date, (counts.get(date) ?? 0) + 1);
  }
  return [...counts].sort((left, right) => right[1] - left[1] || right[0].localeCompare(left[0]))[0]?.[0];
}
