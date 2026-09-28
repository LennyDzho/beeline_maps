import type { RequestItem, RequestEngineer } from "../requests/request-editor";
import type { PlanningRouteResult } from "./planning-types";

export type MapRoute = Pick<PlanningRouteResult, "agentId" | "agentName" | "geometry" | "geometrySource"> & {
  startPoint: {lat:number;lon:number} | null;
  visits: Array<{jobId:string;label:string;point:{lat:number;lon:number}}>;
};

/** Actual assignments only: no proposed visits and no route optimization. */
export function assignedMapRoutes(items: RequestItem[], workers: RequestEngineer[], date: string): MapRoute[] {
  return workers.flatMap(worker => {
    const visits = items.filter(item => item.assigneeId === worker.id && item.dateTime.slice(0,10) === date
      && !["new","cancelled","paused"].includes(item.status) && item.point)
      .sort((a,b) => a.dateTime.localeCompare(b.dateTime) || a.id.localeCompare(b.id))
      .map(item => ({jobId:item.id,label:`Заявка ${item.number ?? "Без номера"}`,point:item.point!}));
    return visits.length ? [{agentId:worker.id,agentName:worker.name,startPoint:null,visits,geometry:[],geometrySource:"fallback" as const}] : [];
  });
}
