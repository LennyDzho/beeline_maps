"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import MaterialIcon from "@/app/components/material-icon";
import { scheduleSummary, type WorkScheduleRecord } from "@/app/admin/work-schedule-data";
import { regionTimezones } from "@/app/lib/regional-time";

import WorkCompetencyChoices from "@/app/components/work-competency-choices";
import type { WorkCategory } from "@/app/lib/work-catalog";
import type { WorkTypeRecord } from "@/app/admin/work-type-data";
import AvailabilityPanel from "./availability-panel";
import EquipmentPanel from "./equipment-panel";

export type ShiftStatus = "on_shift" | "break" | "off_shift";
export type TransportType = "car" | "transit";

export type EngineerVehicle = { id:string; name:string; plate:string; assignedWorkerId:string | null; status:string; condition:string };

export type EngineerRecord = {
  employeeNumber?: string; resourceId?: string;
  workCompetencies?: import("@/app/lib/work-catalog").WorkCompetency[];
  timezone?: string;
  effectiveTimezone?: string;
  id: string;
  initials: string;
  name: string;
  phone: string;
  userId: string;
  status: ShiftStatus;
  skill: string;
  skillIds?: string[];
  skillNames?: string[];
  clearance: string;
  qualificationIds?: string[];
  qualificationNames?: string[];
  load: number;
  transportType: TransportType;
  transport: string;
  section: string;
  warning: boolean;
  workScheduleId: string;
  workScheduleName: string;
  startAddress: string;
  startPoint: { lat: number; lon: number } | null;
};

type EngineerDraft = Omit<EngineerRecord, "status" | "transportType"> & {
  status: ShiftStatus | "";
  transportType: TransportType | "";
};

const emptyDraft: EngineerDraft = {
  id: "",
  initials: "",
  name: "",
  phone: "",
  userId: "",
  status: "",
  skill: "",
  clearance: "",
  load: 0,
  transportType: "transit",
  transport: "",
  section: "",
  warning: false,
  workScheduleId: "",
  workScheduleName: "",
  startAddress: "",
  startPoint: null,
  timezone: "",
};

type GeocodingState = { status: "idle" } | { status: "loading" } | { status: "resolved"; formattedAddress: string } | { status: "error"; message: string };

type EngineerEditorProps = {
  workCategories?: WorkCategory[]; workTypes?: WorkTypeRecord[];
  initialEngineer: EngineerRecord | null;
  vehicles?: EngineerVehicle[];
  users: Array<{ id: string; name: string; email: string }>;
  schedules: WorkScheduleRecord[];

  onClose: () => void;
  onSave: (engineer: EngineerRecord) => void | Promise<void>;
};

export default function EngineerEditor({ workCategories = [], workTypes = [], initialEngineer, users, vehicles = [], schedules, onClose, onSave }: EngineerEditorProps) {
  const [draft, setDraft] = useState<EngineerDraft>(initialEngineer ? { ...initialEngineer } : emptyDraft);
  const [geocoding, setGeocoding] = useState<GeocodingState>(initialEngineer?.startPoint ? { status: "resolved", formattedAddress: initialEngineer.startAddress } : { status: "idle" });
  const resolvedAddressRef = useRef(initialEngineer?.startPoint ? normalizeAddress(initialEngineer.startAddress) : "");
  const editing = initialEngineer !== null;
  const selectedSchedule = schedules.find((schedule) => schedule.id === draft.workScheduleId);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [onClose]);

  useEffect(() => {
    const query = normalizeAddress(draft.startAddress);
    if (query.length < 3 || query === resolvedAddressRef.current) return;
    const controller = new AbortController();
    setGeocoding({ status: "loading" });
    const timer = window.setTimeout(() => {
      fetch(`/api/geocoding?query=${encodeURIComponent(query)}`, { signal: controller.signal, cache: "no-store" })
        .then(async (response) => {
          const payload = await response.json().catch(() => ({})) as { message?: string; candidate?: { formattedAddress: string; point: { lat: number; lon: number } } };
          if (!response.ok || !payload.candidate) throw new Error(payload.message || "Не удалось определить координаты адреса.");
          setDraft((current) => normalizeAddress(current.startAddress) === query ? { ...current, startPoint: payload.candidate!.point } : current);
          resolvedAddressRef.current = query;
          setGeocoding({ status: "resolved", formattedAddress: payload.candidate.formattedAddress });
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted) return;
          setDraft((current) => ({ ...current, startPoint: null }));
          setGeocoding({ status: "error", message: error instanceof Error ? error.message : "Не удалось определить координаты адреса." });
        });
    }, 600);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [draft.startAddress]);

  function changeStartAddress(value: string) {
    resolvedAddressRef.current = "";
    setDraft((current) => ({ ...current, startAddress: value, startPoint: null }));
    setGeocoding({ status: "idle" });
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft.status || !draft.workScheduleId || (draft.startAddress.trim() && !draft.startPoint)) return;
    onSave({
      ...draft,
      section: "", skill: "", clearance: "", warning: false,
      skillIds: [], skillNames: [], qualificationIds: [], qualificationNames: [],
      workCompetencies: draft.workCompetencies ?? [],
      initials: getInitials(draft.name),
      status: draft.status,
      transportType: draft.resourceId ? "car" : "transit",
      transport: draft.resourceId ? vehicles.find(v=>v.id===draft.resourceId)?.plate ?? "" : "Общественный транспорт + пешком",
      resourceId: draft.resourceId ?? "",
    });
  }

  return (
    <div className="request-editor-backdrop engineer-editor-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="request-editor engineer-editor" role="dialog" aria-modal="true" aria-labelledby="engineer-editor-title">
        <form onSubmit={submit}>
          <header>
            <div><span className="engineer-editor-icon"><MaterialIcon name={editing ? "manage_accounts" : "person_add"} /></span><div><h2 id="engineer-editor-title">{editing ? "Редактирование исполнителя" : "Новый исполнитель"}</h2><p>{editing ? `№ ${initialEngineer.employeeNumber ?? ""}` : "Заполните данные сотрудника"}</p></div></div>
            <button type="button" aria-label="Закрыть форму" onClick={onClose}><MaterialIcon name="close" /></button>
          </header>

          <div className="engineer-editor-fields">
            <section>
              <h3><MaterialIcon name="badge" />Основные данные</h3>
              <div className="engineer-field-grid">
                <label><span>Табельный номер</span><input value={draft.employeeNumber ?? ""} placeholder="Будет присвоен автоматически" readOnly /></label>
                <label><span>Исполнитель / бригада *</span><input value={draft.name} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} placeholder="Иванов Иван Иванович" required /></label>
                <label><span>Телефон</span><input type="tel" value={draft.phone} onChange={(event) => setDraft((current) => ({ ...current, phone: event.target.value }))} placeholder="Не указан" /></label>
                <label><span>Пользователь системы</span><select value={draft.userId} onChange={(event) => setDraft((current) => ({ ...current, userId: event.target.value }))}><option value="">Без учётной записи</option>{users.map((systemUser) => <option value={systemUser.id} key={systemUser.id}>{systemUser.name} — {systemUser.email}</option>)}</select></label>
              </div>
            </section>

            <section>
              <h3><MaterialIcon name="engineering" />Рабочие параметры</h3>
              <div className="engineer-field-grid">
                <label><span>Статус смены *</span><select value={draft.status} onChange={(event) => setDraft((current) => ({ ...current, status: event.target.value as ShiftStatus | "" }))} required><option value="" disabled>Выберите статус</option><option value="on_shift">В смене</option><option value="break">На перерыве</option><option value="off_shift">Не в смене</option></select></label>
                <div className="full-field"><WorkCompetencyChoices categories={workCategories} workTypes={workTypes} value={draft.workCompetencies ?? []} onChange={workCompetencies => setDraft(current => ({ ...current, workCompetencies }))} /></div>
                <label className="full-field"><span>Рабочий график *</span><select value={draft.workScheduleId} onChange={(event) => {
                  const workScheduleId = event.target.value;
                  const workScheduleName = schedules.find((schedule) => schedule.id === workScheduleId)?.name ?? "";
                  setDraft((current) => ({ ...current, workScheduleId, workScheduleName }));
                }} required><option value="" disabled>Выберите график</option>{schedules.filter((schedule) => schedule.active || schedule.id === draft.workScheduleId).map((schedule) => <option value={schedule.id} key={schedule.id}>{schedule.name}{schedule.active ? "" : " (отключён)"}</option>)}</select>{selectedSchedule && <small className="engineer-schedule-summary"><MaterialIcon name="link" />Связан со справочником: {scheduleSummary(selectedSchedule)}</small>}</label>
                <div className="engineer-start-point full-field">
                  <label className="address-field"><span>Собственный адрес начала маршрута</span><input value={draft.startAddress} onChange={(event) => changeStartAddress(event.target.value)} placeholder="Пусто — адрес подразделения" /><small className="field-hint">Если адрес не указан, маршрут начинается от офиса подразделения.</small></label>
                  <small className={`geocoding-status ${geocoding.status}`}>{geocoding.status === "loading" ? "Определяем координаты…" : geocoding.status === "resolved" ? `Найдено: ${geocoding.formattedAddress}` : geocoding.status === "error" ? geocoding.message : "Координаты будут получены автоматически"}</small>
                  <label><span>Широта (lat)</span><input value={draft.startPoint?.lat.toFixed(6) ?? ""} placeholder="Определяется по адресу" readOnly aria-label="Широта стартовой точки, только чтение" /></label>
                  <label><span>Долгота (lon)</span><input value={draft.startPoint?.lon.toFixed(6) ?? ""} placeholder="Определяется по адресу" readOnly aria-label="Долгота стартовой точки, только чтение" /></label>
                </div>
                <label className="full-field"><span>Часовой регион исполнителя</span><select value={draft.timezone ?? ""} onChange={event => setDraft(current => ({ ...current, timezone: event.target.value }))}><option value="">Как у подразделения{draft.effectiveTimezone ? ` (${draft.effectiveTimezone})` : ""}</option>{draft.timezone && !regionTimezones.some(([zone]) => zone === draft.timezone) && <option value={draft.timezone}>{draft.timezone}</option>}{regionTimezones.map(([zone, label]) => <option key={zone} value={zone}>{label}</option>)}</select><small className="field-hint">График задаётся во времени этого региона. Изменение пояса не переносит уже назначенные заявки.</small></label>
                <label className="full-field"><span>Текущая загрузка: {draft.load}%</span><input className="engineer-load-input" type="range" min="0" max="100" step="5" value={draft.load} onChange={(event) => setDraft((current) => ({ ...current, load: Number(event.target.value) }))} /></label>
              </div>
            </section>

            <section>
              <h3><MaterialIcon name="commute" />Транспорт</h3>
              <p className="planning-tail-note">Способ передвижения определяется закреплённым автомобилем. OSRM рассчитывает обе группы по автомобильным дорогам.</p>
              <div className="engineer-field-grid">
                <label><span>Госномер</span><select value={draft.resourceId ?? ""} onChange={e=>setDraft(current=>({...current,resourceId:e.target.value}))}><option value="">Без автомобиля — общественный транспорт + пешком</option>{vehicles.filter(v=>v.assignedWorkerId===draft.id || (!v.assignedWorkerId && v.status!=="repair" && v.condition==="serviceable")).map(v=><option key={v.id} value={v.id}>{v.plate} · {v.name}{v.assignedWorkerId===draft.id ? " · закреплён" : ""}</option>)}</select></label>
                <label><span>Способ передвижения</span><input readOnly value={draft.resourceId ? "Автомобиль" : "Общественный транспорт + пешком"} /></label>
              </div>
            </section>
          </div>

          {editing && <div className="engineer-editor-fields"><details className="engineer-availability-details"><summary>Уточнить время и место освобождения</summary><AvailabilityPanel workerId={draft.id} /></details><EquipmentPanel workerId={draft.id} /></div>}
          <footer><button className="engineer-cancel-button" type="button" onClick={onClose}>Отмена</button><button className="stitch-green-button" type="submit" disabled={Boolean(draft.startAddress.trim()) && (!draft.startPoint || geocoding.status === "loading")}><MaterialIcon name="save" />{editing ? "Сохранить изменения" : "Создать исполнителя"}</button></footer>
        </form>
      </section>
    </div>
  );
}

function getInitials(name: string) {
  return name.trim().split(/\s+/u).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join("") || "И";
}

function normalizeAddress(value: string) { return value.trim().replace(/\s+/g, " "); }
