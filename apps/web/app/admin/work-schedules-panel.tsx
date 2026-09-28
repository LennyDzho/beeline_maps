"use client";

import MaterialIcon from "@/app/components/material-icon";
import { scheduleSummary, type WorkScheduleRecord } from "./work-schedule-data";

export default function WorkSchedulesPanel({ schedules, onCreate, onEdit }: { schedules: WorkScheduleRecord[]; onCreate: () => void; onEdit: (schedule: WorkScheduleRecord) => void }) {
  return (
    <section className="system-settings-card work-schedules-card" aria-label="Рабочие графики">
      <header><div><MaterialIcon name="calendar_month" /><div><h2>Рабочие графики</h2><p>Дни, рабочие часы и перерывы исполнителей</p></div></div><button className="schedule-add-button" type="button" onClick={onCreate}><MaterialIcon name="add" />Добавить</button></header>
      <div className="work-schedule-list">
        {schedules.map((schedule) => <button type="button" className="work-schedule-row" onClick={() => onEdit(schedule)} key={schedule.id}>
          <span className="schedule-row-icon"><MaterialIcon name="schedule" /></span>
          <span><b>{schedule.name}</b><small>{scheduleSummary(schedule)}</small></span>
          <em className={schedule.active ? "active" : "inactive"}>{schedule.active ? "Активен" : "Отключён"}</em>
          <MaterialIcon name="edit" />
        </button>)}
        {!schedules.length && <p className="work-schedule-empty">Графики ещё не созданы.</p>}
      </div>
    </section>
  );
}
