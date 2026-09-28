import type { PlanningRouteResult, PreviousPlanningRoute } from "./planning-types";
import { instantToRegionalTime, scheduleTimeToInstant } from "@/app/lib/regional-time";

export default function RouteComparison({before,after,showPrevious,onToggle,onOpenRequest}: {
  before: PreviousPlanningRoute[]; after: PlanningRouteResult[]; showPrevious: boolean;
  onToggle: (value:boolean)=>void; onOpenRequest:(id:string)=>void;
}) {
  if (!before.length) return null;
  const ids=[...new Set([...before.map(r=>r.agentId),...after.map(r=>r.agentId)])];
  return <section className="route-comparison" aria-label="Сравнение маршрутов">
    <label><input type="checkbox" checked={showPrevious} onChange={event=>onToggle(event.target.checked)} />Показать исходные маршруты на карте</label>
    <details><summary>До и после пересчёта · {ids.length} исполнителей</summary>
      <p>Сравнивается оставшаяся очередь заявок. Серые линии — исходный порядок, цветные — новый. Обе линии строятся от подтверждённой точки продолжения; это не история передвижений.</p>
      <div className="route-comparison-list">
        {ids.map(id=>{
          const previous=before.find(r=>r.agentId===id),next=after.find(r=>r.agentId===id);
          const timezone=next?.timezone ?? previous!.visits[0]!.timezone;
          return <article key={id} aria-label={`Сравнение: ${next?.agentName ?? previous!.agentName}`}>
            <strong>{next?.agentName ?? previous!.agentName}</strong>
            <small>Время: {timezone}</small>
            <div className="route-comparison-columns">
              <div><b>До пересчёта</b>{previous ? <ol>{previous.visits.map(v=><li key={v.jobId}><button type="button" onClick={()=>onOpenRequest(v.jobId)}>{v.label}</button> · {instantToRegionalTime(scheduleTimeToInstant(v.startAt,v.timezone),timezone).slice(11,16)}</li>)}</ol> : <p>Заявок не было.</p>}</div>
              <div><b>После пересчёта</b>{next ? <ol>{next.visits.map(v=><li key={v.jobId}><button type="button" onClick={()=>onOpenRequest(v.jobId)}>{v.label}</button> · {instantToRegionalTime(v.serviceStartAt,next.timezone).slice(11,16)}{v.change && <small>{v.change.label}</small>}</li>)}</ol> : <p>Все заявки сняты.</p>}</div>
            </div>
            {previous?.warning && <p className="route-comparison-warning">{previous.warning}</p>}
          </article>;
        })}
      </div>
    </details>
  </section>;
}
