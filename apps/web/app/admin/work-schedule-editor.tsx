"use client";

import { useEffect, useState, type FormEvent } from "react";
import MaterialIcon from "@/app/components/material-icon";
import { createDefaultScheduleDays, weekdayLabels, type WorkScheduleRecord } from "./work-schedule-data";

export default function WorkScheduleEditor({ initialSchedule, onClose, onSave }: { initialSchedule: WorkScheduleRecord | null; onClose: () => void; onSave: (schedule: WorkScheduleRecord) => void | Promise<void> }) {
  const [draft, setDraft] = useState<WorkScheduleRecord>(initialSchedule ? structuredClone(initialSchedule) : { id: "", name: "", active: true, days: createDefaultScheduleDays() });
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const listener = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", listener);
    return () => { document.body.style.overflow = previous; window.removeEventListener("keydown", listener); };
  }, [onClose]);

  function updateDay(weekday: number, patch: Partial<WorkScheduleRecord["days"][number]>) {
    setDraft((current) => ({ ...current, days: current.days.map((day) => day.weekday === weekday ? { ...day, ...patch } : day) }));
  }
  function submit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); onSave(draft); }

  return <div className="request-editor-backdrop engineer-editor-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="request-editor engineer-editor schedule-editor" role="dialog" aria-modal="true" aria-labelledby="schedule-editor-title">
      <form onSubmit={submit}>
        <header><div><span className="engineer-editor-icon"><MaterialIcon name="calendar_month" /></span><div><h2 id="schedule-editor-title">{initialSchedule ? "Редактирование графика" : "Новый рабочий график"}</h2><p>Рабочие дни, часы и один перерыв в день</p></div></div><button type="button" aria-label="Закрыть форму" onClick={onClose}><MaterialIcon name="close" /></button></header>
        <div className="schedule-editor-body">
          <div className="schedule-editor-heading"><label><span>Название *</span><input value={draft.name} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} placeholder="Стандартный 5/2" required /></label><label className="schedule-active"><input type="checkbox" checked={draft.active} onChange={(event) => setDraft((current) => ({ ...current, active: event.target.checked }))} /><span>График активен</span></label></div>
          <div className="schedule-days-header"><span>День</span><span>Начало</span><span>Конец</span><span>Перерыв</span></div>
          <div className="schedule-days">
            {draft.days.map((day) => <div className={`schedule-day ${day.enabled ? "enabled" : ""}`} key={day.weekday}>
              <label className="schedule-day-toggle"><input type="checkbox" checked={day.enabled} onChange={(event) => updateDay(day.weekday, { enabled: event.target.checked })} /><span>{weekdayLabels[day.weekday - 1]}</span></label>
              <input aria-label={`Начало работы, ${weekdayLabels[day.weekday - 1]}`} type="time" value={day.startTime} disabled={!day.enabled} onChange={(event) => updateDay(day.weekday, { startTime: event.target.value })} required={day.enabled} />
              <input aria-label={`Конец работы, ${weekdayLabels[day.weekday - 1]}`} type="time" value={day.endTime} disabled={!day.enabled} onChange={(event) => updateDay(day.weekday, { endTime: event.target.value })} required={day.enabled} />
              <span className="schedule-break"><input aria-label={`Начало перерыва, ${weekdayLabels[day.weekday - 1]}`} type="time" value={day.breakStart} disabled={!day.enabled} onChange={(event) => updateDay(day.weekday, { breakStart: event.target.value })} /><i>—</i><input aria-label={`Конец перерыва, ${weekdayLabels[day.weekday - 1]}`} type="time" value={day.breakEnd} disabled={!day.enabled} onChange={(event) => updateDay(day.weekday, { breakEnd: event.target.value })} /></span>
            </div>)}
          </div>
        </div>
        <footer><button className="engineer-cancel-button" type="button" onClick={onClose}>Отмена</button><button className="stitch-green-button" type="submit"><MaterialIcon name="save" />Сохранить график</button></footer>
      </form>
    </section>
  </div>;
}
