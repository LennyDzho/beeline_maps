import MaterialIcon from "@/app/components/material-icon";
import type { ReactNode } from "react";
// Named scroll regions must be focusable for keyboard scrolling.
/* eslint jsx-a11y/no-noninteractive-tabindex: ["error", {"roles": ["region"]}] */
import type { Engineer } from "./data";
import type { PlanningUnassignedResult } from "./planning-types";

type EngineerPanelProps = {
  engineers: Engineer[];
  selectedId: string;
  onSelect: (id: string) => void;
  onOpenRequest: (requestId: string) => void;
  unassigned?: PlanningUnassignedResult[];
  viewControl?: ReactNode;
};

export default function EngineerPanel({ engineers, selectedId, onSelect, onOpenRequest, unassigned = [], viewControl }: EngineerPanelProps) {
  return (
    <section className="engineer-panel" aria-label="Исполнители">
      {viewControl}
      <div className="engineer-panel-heading">
        <h3>Исполнители ({engineers.length})</h3>
        <label className="engineer-search">
          <MaterialIcon name="search" />
          <span className="sr-only">Поиск инженера</span>
          <input type="search" placeholder="Поиск инженера..." />
        </label>
      </div>

      <div className="engineer-cards" role="region" aria-label="Список исполнителей" tabIndex={0}>
        {!engineers.length && <p className="engineer-panel-empty">Для выбранного подразделения исполнители не добавлены.</p>}
        {engineers.map((engineer) => (
          <article
            className={`engineer-card ${engineer.accent} ${selectedId === engineer.id ? "selected" : ""}`}
            key={engineer.id}
          >
            <span className="engineer-accent" />
            <button className="engineer-card-select" type="button" onClick={() => onSelect(engineer.id)} aria-label={`Показать маршрут исполнителя ${engineer.name}`} aria-pressed={selectedId === engineer.id}>
              <span className="engineer-card-header">
                <span className="engineer-avatar">{engineer.initials}</span>
                <span className="engineer-person">
                  <strong>{engineer.name}</strong>
                  <small>{engineer.vehicle}</small>
                  {engineer.schedule && <small className="engineer-schedule"><MaterialIcon name="schedule" />{engineer.schedule}</small>}
                </span>
                <span className="engineer-load">{engineer.load}%</span>
              </span>
            </button>

            {engineer.routeSummary && <span className="engineer-route-summary">{engineer.routeSummary}</span>}

            {engineer.visits.length > 0 && <div className="engineer-stops" role="region" aria-label={`Задачи исполнителя ${engineer.name}`} tabIndex={0}>
              {engineer.visits.map((visit) => (
                <span className={`engineer-stop ${visit.paused ? "paused" : ""} ${visit.change ? `draft-change ${visit.change.kind}` : ""}`} key={`${engineer.id}-${visit.requestId ?? visit.time}`}>
                  <span className="stop-dot" />
                  <time>{visit.time}</time>
                  {visit.requestId
                    ? <button className={`job-label ${visit.change ? "changed" : ""}`} type="button" onClick={() => onOpenRequest(visit.requestId as string)}>
                        <span>{visit.label}{visit.travel ? ` · ${visit.travel} в пути` : ""}</span>
                        {visit.paused && <small><MaterialIcon name="pause_circle" />Приостановлена</small>}
                        {visit.equipmentWarning && <small className="schedule-conflict-text">{visit.equipmentWarning}</small>}
                        {visit.scheduleConflicts?.map(conflict => <small key={conflict.requestId} className="schedule-conflict-text">{conflict.detail}</small>)}
                        {visit.protectedStatus && <small><MaterialIcon name="lock" />{visit.protectedStatus==='en_route'?'В пути':'В работе'} · сохранена при перепланировании</small>}
                        {visit.change && <small><MaterialIcon name={changeIcon(visit.change.kind)} /><span>{visit.change.label}</span></small>}
                      </button>
                    : <span className={visit.kind === "return" ? "return-label" : "travel-label"}>{visit.label}{visit.travel ? ` (${visit.travel})` : ""}</span>}
                </span>
              ))}
            </div>}
            {Boolean(engineer.removedAssignments?.length) && <div className="removed-assignments" aria-label={`Снятые заявки исполнителя ${engineer.name}`}>
              {engineer.removedAssignments?.map(item => <div key={item.requestId}>
                <button type="button" onClick={() => onOpenRequest(item.requestId)}><MaterialIcon name="person_remove" />Снята: {item.label}</button>
                <small>{item.reason}</small>
              </div>)}
            </div>}
          </article>
        ))}
      </div>
      {unassigned.length > 0 && <aside className="planning-unassigned" aria-label="Нераспределённые заявки">
          <header><MaterialIcon name="warning" /><strong>Не распределено: {unassigned.length}</strong></header>
          <div className="planning-unassigned-list" role="region" aria-label="Список нераспределённых заявок" tabIndex={0}>
            {unassigned.map((item) => <article key={item.jobId}>
              <button type="button" onClick={() => onOpenRequest(item.jobId)}><b>{item.label}</b><MaterialIcon name="open_in_new" /></button>
              <span>{item.detail || unassignedReason(item.reason)}</span>
            </article>)}
          </div>
      </aside>}
    </section>
  );
}

function changeIcon(kind: "assigned" | "reassigned" | "rescheduled") {
  if (kind === "assigned") return "person_add";
  if (kind === "reassigned") return "swap_horiz";
  return "schedule";
}

function unassignedReason(reason: string) {
  if (reason === "no_qualified_agent") return "Нет исполнителя с необходимыми навыками и допусками.";
  if (reason === "time_window_infeasible") return "Заявка не помещается в рабочий график.";
  if (reason === "no_route") return "Не удалось построить маршрут.";
  if (reason === "geocoding_failed") return "Не удалось определить координаты адреса.";
  return "Заявка требует ручной проверки диспетчером.";
}
