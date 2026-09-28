import type { PlanningProblem, RouteGeometryPort } from "@mmi/provider-contracts";
import type { PreviousPlanningRoute } from "@/app/dispatcher/planning-types";

type PreviousOrder = {
  id: string; number: string; work_name: string; assignee_worker_id: string | null; assignee_name: string | null;
  scheduled_start: string; scheduling_timezone: string; baseline_sequence: number | null;
  latitude: number | null; longitude: number | null;
};

/** Compare the remaining queue from the same confirmed continuation point.
 * A worker without known availability has no trustworthy starting point. */
export async function buildPreviousRoutes(rows: readonly PreviousOrder[], problem: PlanningProblem, adapter: RouteGeometryPort, signal?: AbortSignal): Promise<PreviousPlanningRoute[]> {
  const workerIds = [...new Set(rows.map(row => row.assignee_worker_id).filter((id): id is string => Boolean(id)))];
  return Promise.all(workerIds.map(async agentId => {
    const orders = rows.filter(row => row.assignee_worker_id === agentId)
      .sort((a,b) => (a.baseline_sequence ?? Infinity) - (b.baseline_sequence ?? Infinity) || a.scheduled_start.localeCompare(b.scheduled_start) || a.id.localeCompare(b.id));
    const agent = problem.agents.find(item => item.id === agentId), shift = agent?.shifts[0];
    const route: PreviousPlanningRoute = {
      agentId, agentName: orders[0]!.assignee_name ?? agentId, startPoint: shift?.startLocation ?? null,
      visits: orders.map(row => ({jobId:row.id, label:`${row.work_name} · ${row.number}`, startAt:row.scheduled_start, timezone:row.scheduling_timezone,
        point:row.latitude !== null && row.longitude !== null && Number.isFinite(row.latitude) && Number.isFinite(row.longitude)
          && Math.abs(row.latitude)<=90 && Math.abs(row.longitude)<=180 ? {lat:row.latitude,lon:row.longitude} : null})),
      geometry:[], geometrySource:"fallback",
    };
    if (!agent || !shift) { route.warning="Исходная дорожная линия недоступна: не подтверждены доступность и точка продолжения маршрута исполнителя."; return route; }
    if (route.visits.some(visit => !visit.point)) { route.warning="Исходная дорожная линия недоступна: не у всех заявок определены координаты."; return route; }
    try {
      const response = await adapter.buildRoute({stops:[
        {id:`start:${agentId}`,point:shift.startLocation},
        ...route.visits.map(visit=>({id:visit.jobId,point:visit.point!})),
        ...(shift.endLocation ? [{id:`end:${agentId}`,point:shift.endLocation}] : []),
      ],profile:agent.travelProfile ?? problem.profile,departureAt:shift.window.startAt,alternatives:1},
      {timeoutMs:15_000,traceId:`${problem.id}:before:${agentId}`,...(signal ? {signal} : {})});
      const geometry=response.data[0]?.geometry ?? [];
      if (geometry.length<2) throw new Error("empty geometry");
      route.geometry=[...geometry]; route.geometrySource=adapter.providerId==="osrm" ? "osrm" : "2gis";
    } catch { route.warning="Исходная дорожная линия недоступна: картографический сервис не вернул маршрут. Список заявок сохранён."; }
    return route;
  }));
}
