import type { PlanningAgent } from "@mmi/provider-contracts";
import { instantToRegionalTime } from "../../regional-time";

// An estimate is tied to the active work and worker settings it was made for.
// Changing a status, assignment or worker invalidates it without a side-effecting trigger.
export const activityRevisionSql = `json_array(w.shift_status,w.work_schedule_id,w.timezone,w.active,(SELECT json_group_array(json_array(id,status,revision))
  FROM (SELECT id,status,revision FROM work_orders WHERE assignee_worker_id=w.id AND status IN ('en_route','in_progress','paused') ORDER BY id)))`;

export type AvailabilityRow = {
  worker_id: string; available_at: string; address: string; latitude: number; longitude: number;
  activity_revision: string; updated_at: string;
};
export type ActiveActivity = { id: string; number: string; worker_id: string; status: string };

export async function workerAvailability(database: D1Database, organizationId: string, workerId: string) {
  const worker = await database.prepare(`SELECT w.id,w.full_name,COALESCE(w.timezone,o.timezone) AS timezone,
    ${activityRevisionSql} AS activityRevision FROM workers w JOIN organizations o ON o.id=w.organization_id
    WHERE w.id=? AND w.organization_id=?`).bind(workerId, organizationId)
    .first<{ id: string; full_name: string; timezone: string; activityRevision: string }>();
  if (!worker) return null;
  const [estimate, activities] = await Promise.all([
    database.prepare("SELECT * FROM worker_planning_availability WHERE worker_id=?").bind(workerId).first<AvailabilityRow>(),
    database.prepare("SELECT id,number,status FROM work_orders WHERE assignee_worker_id=? AND status IN ('en_route','in_progress','paused') ORDER BY id")
      .bind(workerId).all<{ id: string; number: string; status: string }>(),
  ]);
  return { workerId, timezone: worker.timezone, activityRevision: worker.activityRevision, activities: activities.results,
    estimate: estimate ? { availableAt: instantToRegionalTime(estimate.available_at,worker.timezone).slice(0,16), address: estimate.address,
      point: { lat: estimate.latitude, lon: estimate.longitude }, stale: estimate.activity_revision !== worker.activityRevision } : null };
}

/** Only the unstarted tail is optimized. Protected work stays in the database.
 * With unknown release time/location, a busy worker is explicitly excluded.
 * The dispatcher can provide an estimate; it is never inferred from a paused job.
 */
export async function availableAgents(database: D1Database, organizationId: string, agents: PlanningAgent[], at: string) {
  const [active, estimates, workers, completed] = await Promise.all([
    database.prepare(`SELECT id,number,assignee_worker_id AS worker_id,status FROM work_orders
      WHERE organization_id=? AND assignee_worker_id IS NOT NULL AND status IN ('en_route','in_progress','paused')`).bind(organizationId).all<ActiveActivity>(),
    database.prepare(`SELECT a.* FROM worker_planning_availability a JOIN workers w ON w.id=a.worker_id WHERE w.organization_id=?`).bind(organizationId).all<AvailabilityRow>(),
    database.prepare(`SELECT w.id,w.full_name,w.shift_status,${activityRevisionSql} AS activity_revision FROM workers w WHERE w.organization_id=?`)
      .bind(organizationId).all<{id:string; full_name:string; shift_status:string; activity_revision:string}>(),
    database.prepare(`SELECT o.assignee_worker_id AS worker_id,o.completed_at,COALESCE(o.latitude_snapshot,s.latitude) AS latitude,COALESCE(o.longitude_snapshot,s.longitude) AS longitude
      FROM work_orders o LEFT JOIN service_objects s ON s.id=o.service_object_id WHERE o.organization_id=? AND o.completed_at IS NOT NULL
        AND o.status IN ('completed','confirmed') ORDER BY o.completed_at DESC,o.id`).bind(organizationId)
      .all<{worker_id:string; completed_at:string; latitude:number|null; longitude:number|null}>(),
  ]);
  const warnings: string[] = [], available: PlanningAgent[] = [];
  const now=Date.parse(at);
  for (const agent of agents) {
    const worker=workers.results.find(w=>w.id===agent.id)!;
    const activities=active.results.filter(a=>a.worker_id===agent.id);
    const estimate=estimates.results.find(e=>e.worker_id===agent.id);
    const estimateTime=estimate ? Date.parse(estimate.available_at) : NaN;
    const shift=agent.shifts[0]!;
    const shiftStart=Date.parse(shift.window.startAt), shiftEnd=Date.parse(shift.window.endAt);
    const effectiveNow=Math.max(now,shiftStart);
    const validEstimate=Boolean(estimate && estimate.activity_revision===worker.activity_revision && estimateTime>=effectiveNow && estimateTime<shiftEnd);
    const scheduledBreak=(shift.breaks ?? []).some(b=>Date.parse(b.startAt)<=effectiveNow && effectiveNow<Date.parse(b.endAt));
    if ((activities.length || worker.shift_status==='break' && !scheduledBreak) && !validEstimate) {
      const jobs=activities.map(a=>`№${a.number}`).join(', ');
      warnings.push(`${worker.full_name}: не участвует — ${jobs ? `защищённые заявки ${jobs}` : 'перерыв вне графика'}. Укажите актуальные время освобождения и место продолжения маршрута в карточке исполнителя.`);
      continue;
    }
    let start=Math.max(effectiveNow,validEstimate ? estimateTime : effectiveNow), point=shift.startLocation;
    if (validEstimate && estimate) {
      point={lat:estimate.latitude,lon:estimate.longitude};
      warnings.push(`${worker.full_name}: продолжение маршрута по оценке диспетчера с ${estimate.available_at}; начатые и приостановленные заявки сохранены.`);
    } else {
      const last=completed.results.find(c=>c.worker_id===agent.id && Date.parse(c.completed_at)>=shiftStart && Date.parse(c.completed_at)<=effectiveNow);
      if (last && isPoint(last.latitude,last.longitude)) {
        point={lat:last.latitude!,lon:last.longitude!};
        warnings.push(`${worker.full_name}: старт остатка маршрута — последняя завершённая заявка. Текущая GPS-позиция не подтверждена.`);
      }
    }
    // A scheduled break may be spent at the start point before setting out.
    for (const pause of shift.breaks ?? []) if (Date.parse(pause.startAt)<=start && start<Date.parse(pause.endAt)) start=Date.parse(pause.endAt);
    if (start>=shiftEnd) { warnings.push(`${worker.full_name}: смена закончилась к моменту перепланирования.`); continue; }
    if (!isPoint(point.lat,point.lon)) { warnings.push(`${worker.full_name}: не определено место начала маршрута. Укажите свой адрес или адрес подразделения.`); continue; }
    available.push({...agent,alreadyEngaged:activities.length>0,shifts:[{...shift,window:{...shift.window,startAt:new Date(start).toISOString()},startLocation:point,
      breaks:(shift.breaks ?? []).filter(b=>Date.parse(b.endAt)>start)}]});
  }
  return { agents:available,warnings,protectedJobs:active.results.map(a=>a.id),engagedWorkerIds:[...new Set(active.results.map(a=>a.worker_id))] };
}

function isPoint(lat: unknown,lon:unknown): boolean {
  return typeof lat==='number' && Number.isFinite(lat) && Math.abs(lat)<=90 && typeof lon==='number' && Number.isFinite(lon) && Math.abs(lon)<=180;
}
