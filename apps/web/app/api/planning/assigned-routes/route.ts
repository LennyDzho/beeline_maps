import { env } from "cloudflare:workers";
import { NextResponse } from "next/server";
import { badRequest, isApiError, requireApiContext, serverError } from "@/app/api/_shared";
import { listPlanningDepartments } from "@/app/lib/server/planning/common-plan";
import { loadPlanningSettings } from "@/app/lib/server/planning/settings-storage";
import { selectRouteGeometryProvider } from "@/app/lib/server/planning/providers";
import { WORKER_TRANSPORT_SQL, workerTravelProfile, type WorkerTransportMode } from "@/app/lib/server/planning/worker-travel-policy";
import { scheduleTimeToInstant } from "@/app/lib/regional-time";
import type { MapRoute } from "@/app/dispatcher/assigned-routes";

export const dynamic = "force-dynamic";
type Row = {id:string;number:string;worker_id:string;name:string;lat:number|null;lon:number|null;start_lat:number|null;start_lon:number|null;scheduled_start:string;timezone:string;mode:WorkerTransportMode};
function point(lat:number|null,lon:number|null) { return lat!==null && lon!==null && Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat)<=90 && Math.abs(lon)<=180 ? {lat,lon} : null; }

/** Read-only geometry for fixed database assignments. Never invokes a solver or writes a plan. */
export async function GET(request:Request) {
  try {
    const ctx=await requireApiContext(request); if(isApiError(ctx))return ctx;
    const date=new URL(request.url).searchParams.get("date") ?? "";
    if(!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0,10)!==date)return badRequest("Укажите дату.");
    const departments=await listPlanningDepartments(ctx.database,ctx.user.id);
    if(!departments.length)return NextResponse.json({message:"Нет доступа к планированию."},{status:403});
    const settings=await loadPlanningSettings(ctx.database);
    const rows:Row[]=[];
    for(const department of departments) {
      const result=await ctx.database.prepare(`SELECT o.id,o.number,workers.id AS worker_id,workers.full_name AS name,
        COALESCE(o.latitude_snapshot,objects.latitude) AS lat,COALESCE(o.longitude_snapshot,objects.longitude) AS lon,
        CASE WHEN TRIM(workers.start_address)='' THEN org.office_latitude ELSE workers.start_latitude END AS start_lat,
        CASE WHEN TRIM(workers.start_address)='' THEN org.office_longitude ELSE workers.start_longitude END AS start_lon,
        o.scheduled_start,COALESCE(o.scheduling_timezone,org.timezone) AS timezone,${WORKER_TRANSPORT_SQL} AS mode
        FROM work_orders o JOIN workers ON workers.id=o.assignee_worker_id AND workers.organization_id=o.organization_id
        JOIN organizations org ON org.id=o.organization_id LEFT JOIN service_objects objects ON objects.id=o.service_object_id
        WHERE o.organization_id=? AND SUBSTR(o.scheduled_start,1,10)=? AND o.status NOT IN ('new','cancelled','paused')
        AND workers.active=1 ORDER BY workers.id,o.scheduled_start,o.id`).bind(department.id,date).all<Row>();
      rows.push(...result.results);
    }
    const routes:MapRoute[]=[];
    const adapter=rows.length ? selectRouteGeometryProvider(settings.travelMatrixProvider,env.TWO_GIS_API_KEY?.trim() ?? "",{drivingUrl:env.OSRM_BASE_URL}) : null;
    const signal=AbortSignal.any([request.signal,AbortSignal.timeout(60000)]);
    for(const workerId of new Set(rows.map(row=>row.worker_id))) {
      const assigned=rows.filter(row=>row.worker_id===workerId),worker=assigned[0]!;
      const visits=assigned.flatMap(row=>{const location=point(row.lat,row.lon);return location ? [{jobId:row.id,label:`Заявка ${row.number}`,point:location}] : [];});
      if(!visits.length)continue;
      const route:MapRoute={agentId:workerId,agentName:worker.name,startPoint:point(worker.start_lat,worker.start_lon),visits,geometry:[],geometrySource:"fallback"};
      routes.push(route);
    }
    let next = 0;
    const loadGeometry = async () => {
      while (next < routes.length && !signal.aborted) {
        const route = routes[next++]!;
        const assigned = rows.filter(row => row.worker_id === route.agentId), worker = assigned[0]!;
        // Do not bridge an unknown stop and present a partial line as a full route.
        if (route.visits.length !== assigned.length) continue;
        const stops = [...(route.startPoint ? [{id:`start:${route.agentId}`,point:route.startPoint}] : []), ...route.visits.map(v=>({id:v.jobId,point:v.point}))];
        if (stops.length < 2) continue;
        try {
          const result = await adapter!.buildRoute({stops,profile:workerTravelProfile(worker.mode,settings),departureAt:scheduleTimeToInstant(worker.scheduled_start,worker.timezone)},{signal,timeoutMs:10000});
          const geometry = result.data[0]?.geometry;
          if (geometry && geometry.length >= 2) {
            route.geometry = [...geometry];
            route.geometrySource = settings.travelMatrixProvider === "osrm" ? "osrm" : "2gis";
          }
        } catch { /* Keep assignment markers available when the road service fails. */ }
      }
    };
    await Promise.all(Array.from({length:Math.min(4,routes.length)}, loadGeometry));
    return NextResponse.json({routes},{headers:{"Cache-Control":"no-store"}});
  } catch(error){return serverError(error);}
}
