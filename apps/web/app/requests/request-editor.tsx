"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import MaterialIcon from "@/app/components/material-icon";
import { addMinutesToTimestamp, formatDuration } from "@/app/lib/planned-duration";
import ProblemLog, { type ProblemEntry } from "./problem-log";

import { findServiceConflicts } from "@/app/lib/scheduling-changes";
import { equipmentWarning, type BrigadeEquipment } from "@/app/lib/brigade-equipment";
import { hasWorkCompetencies, mergeEquipmentRequirements, type WorkCategory, type EquipmentSnapshot } from "@/app/lib/work-catalog";

export type RequestPoint = { lat: number; lon: number };

export type RequestStatus = "new" | "assigned" | "working" | "paused" | "completed" | "confirmed" | "cancelled";
export type RequestPriority = "high" | "medium" | "low";

export type CompletionMedia = {
  id: string;
  kind: "photo" | "video";
  name: string;
  meta: string;
  url?: string;
};

export type CompletionReport = {
  sections?: import("@/app/lib/report-requirements").ReportSectionResult[];
  performer: string;
  submittedAt: string;
  comment: string;
  media: CompletionMedia[];
};

export type RequestItem = {
  isEmergency?: boolean;
  organizationId?: string;
  equipmentWarning?: string | null;
  clientVisitConfirmed?: boolean;
  /** Explicit acknowledgement for this edit; never returned as a saved default. */
  clientNotified?: boolean;
  schedulingChanges?: import("@/app/lib/scheduling-changes").SchedulingChange[];
  scheduleConflicts?: import("@/app/lib/scheduling-changes").ScheduleConflict[];
  categoryId?: string; workTypeIds?: string[]; workTypeVersionIds?: string[];
  serviceDurationMinutes?: number; durationSource?: string; equipment?: import("@/app/lib/work-catalog").EquipmentSnapshot[];
  id: string;
  number?: string;
  work: string;
  requiredSkills: string[];
  requiredQualifications: string[];
  description: string;
  priority: RequestPriority;
  status: RequestStatus;
  executionStatus?: "en_route" | "in_progress";
  dateTime: string;
  schedulingTimezone?: string;
  clientWindowStart?: string;
  clientWindowEnd?: string;
  buildingAddress?: string;
  apartment?: string;
  entrance?: string;
  intercom?: string;
  address: string;
  point: RequestPoint | null;
  assignee: string;
  assigneeId?: string;
  revision?: number;
  completionReport?: CompletionReport;
  problems?: string[];
  problemLog?: ProblemEntry[];
};

type RequestDraft = Omit<RequestItem, "priority" | "status"> & {
  priority: RequestPriority | "";
  status: RequestStatus | "";
};

const emptyDraft: RequestDraft = {
  id: "",
  work: "",
  requiredSkills: [],
  requiredQualifications: [],
  description: "",
  priority: "",
  status: "",
  dateTime: "",
  address: "",
  point: null,
  assignee: "",
};

type GeocodingState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "resolved"; formattedAddress: string }
  | { status: "error"; message: string };

type RequestEditorProps = {
  otherRequests?: RequestItem[];
  workCategories?: WorkCategory[];
  initialRequest: RequestItem | null;
  departmentTimezone?: string;
  workTypes: RequestWorkType[];
  engineers: RequestEngineer[];
  onClose: () => void;
  onSave: (request: RequestItem) => void | Promise<void>;
};

export type RequestWorkType = {
  isEmergency?: boolean;
  organizationId?: string;
  categoryIds?: string[]; equipment?: EquipmentSnapshot[];
  id: string;
  name: string;
  plannedDurationMinutes: number;
  requiredSkills: string[];
  requiredQualifications: string[];
};

export type RequestEngineer = {
  organizationId?: string;
  equipmentByDate?: Record<string,BrigadeEquipment>;
  workCompetencies?: import("@/app/lib/work-catalog").WorkCompetency[];
  id: string;
  name: string;
  load: number;
  vehicle: string;
  skills: string[];
  qualifications: string[];
};

export default function RequestEditor({ otherRequests = [], workCategories = [], departmentTimezone, initialRequest, workTypes, engineers, onClose, onSave }: RequestEditorProps) {
  const [draft, setDraft] = useState<RequestDraft>(initialRequest ? {
    ...initialRequest,
    assignee: initialRequest.assignee,
    requiredSkills: [...initialRequest.requiredSkills],
    requiredQualifications: [...initialRequest.requiredQualifications],
  } : emptyDraft);
  const [geocoding, setGeocoding] = useState<GeocodingState>(initialRequest?.point
    ? { status: "resolved", formattedAddress: initialRequest.address }
    : { status: "idle" });
  const resolvedAddressRef = useRef(initialRequest?.point ? normalizeAddress(initialRequest.buildingAddress || initialRequest.address) : "");
  const editing = initialRequest !== null;
  const eligibleEngineers = draft.work ? engineers.filter(engineer =>
    (!draft.categoryId || hasWorkCompetencies(engineer.workCompetencies ?? [], draft.categoryId, draft.workTypeIds ?? []))) : [];
  const selectedWorkType = workTypes.find(workType => workType.name === draft.work);
  const sameWork=initialRequest && initialRequest.categoryId===draft.categoryId && JSON.stringify(initialRequest.workTypeIds)===JSON.stringify(draft.workTypeIds) && initialRequest.work===draft.work;
  const isEmergency=sameWork ? Boolean(initialRequest.isEmergency) : workTypes.some(type=>(draft.workTypeIds?.includes(type.id) || (!draft.workTypeIds?.length && type.name===draft.work)) && type.isEmergency);
  const priority: RequestPriority | ""=isEmergency ? "high" : draft.priority;
  const windowStart=isEmergency && draft.dateTime ? `${draft.dateTime.slice(0,10)}T00:00` : draft.clientWindowStart ?? "";
  const windowEnd=isEmergency && draft.dateTime ? `${draft.dateTime.slice(0,10)}T23:59` : draft.clientWindowEnd ?? "";
  const serviceDuration = draft.serviceDurationMinutes ?? selectedWorkType?.plannedDurationMinutes;
  const conflicts = findServiceConflicts({ ...draft, serviceDurationMinutes: serviceDuration }, otherRequests, draft.schedulingTimezone || departmentTimezone || "Europe/Moscow");
  const plannedEnd = serviceDuration && draft.dateTime ? addMinutesToTimestamp(draft.dateTime, serviceDuration) : null;
  const missingEquipment=equipmentWarning(draft.equipment ?? [],engineers.find(item=>item.id===draft.assigneeId)?.equipmentByDate?.[draft.dateTime.slice(0,10)]);
  const clientChange = Boolean(initialRequest?.clientVisitConfirmed && (
    !draft.clientVisitConfirmed || initialRequest.assigneeId !== draft.assigneeId || initialRequest.dateTime !== draft.dateTime
    || initialRequest.serviceDurationMinutes !== serviceDuration || (initialRequest.clientWindowStart ?? "") !== windowStart
    || (initialRequest.clientWindowEnd ?? "") !== windowEnd || initialRequest.address !== draft.address
    || (initialRequest.status !== "cancelled" && draft.status === "cancelled")));
  const clientChangeKey = JSON.stringify([draft.clientVisitConfirmed,draft.assigneeId,draft.dateTime,serviceDuration,windowStart,windowEnd,draft.address,draft.status]);
  const [clientNotifiedKey, setClientNotifiedKey] = useState<string | null>(null);
  const clientNotified = clientChange && clientNotifiedKey === clientChangeKey;

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
    const query = normalizeAddress(draft.buildingAddress || draft.address);
    if (query.length < 3 || query === resolvedAddressRef.current) return;

    const controller = new AbortController();
    setGeocoding({ status: "loading" });
    const timer = window.setTimeout(() => {
      fetch(`/api/geocoding?query=${encodeURIComponent(query)}`, { signal: controller.signal, cache: "no-store" })
        .then(async (response) => {
          const payload = await response.json().catch(() => ({})) as {
            message?: string;
            candidate?: { formattedAddress: string; point: RequestPoint };
          };
          if (!response.ok || !payload.candidate) throw new Error(payload.message || "Не удалось определить координаты адреса.");
          setDraft((current) => normalizeAddress(current.buildingAddress || current.address) === query
            ? { ...current, point: payload.candidate!.point }
            : current);
          resolvedAddressRef.current = query;
          setGeocoding({ status: "resolved", formattedAddress: payload.candidate.formattedAddress });
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted) return;
          setDraft((current) => ({ ...current, point: null }));
          setGeocoding({ status: "error", message: error instanceof Error ? error.message : "Не удалось определить координаты адреса." });
        });
    }, 600);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [draft.address, draft.buildingAddress]);

  function changeAddress(address: string) {
    const normalized = normalizeAddress(draft.buildingAddress || address);
    resolvedAddressRef.current = "";
    setDraft((current) => ({ ...current, address, point: null }));
    setGeocoding(normalized.length >= 3 ? { status: "loading" } : { status: "idle" });
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft.work || !priority || !draft.status || !draft.point) {
      if (!draft.point) setGeocoding({ status: "error", message: "Сначала необходимо определить координаты адреса." });
      return;
    }
    if (clientChange && !clientNotified) return;
    onSave({ ...draft, priority, status: draft.status, clientNotified });
  }

  function selectWorkType(name: string) {
    const workType = workTypes.find((item) => item.name === name);
    const requiredSkills = workType ? [...workType.requiredSkills] : [];
    const requiredQualifications = workType ? [...workType.requiredQualifications] : [];
    setDraft((current) => ({
      ...current,
      work: name, categoryId: "", workTypeIds: undefined, serviceDurationMinutes: workType?.plannedDurationMinutes, durationSource: "version", equipment: workType?.equipment ?? [],
      assignee: engineers.some((engineer) => engineer.name === current.assignee) ? current.assignee : "",
      requiredSkills,
      requiredQualifications,
    }));
  }

  function selectComponents(ids: string[], categoryId = draft.categoryId ?? "") {
    const category = workCategories.find(item => item.id === categoryId);
    const selected = ids.map(id => workTypes.find(item => item.id === id)!).filter(Boolean);
    setDraft(current => ({ ...current, categoryId, workTypeIds: ids, work: selected.map(item => item.name).join(" + "),
      requiredSkills: [...new Set(selected.flatMap(item => item.requiredSkills))],
      requiredQualifications: [...new Set(selected.flatMap(item => item.requiredQualifications))],
      equipment: workCategories.find(item=>item.id===categoryId)?.equipment ?? mergeEquipmentRequirements(selected.flatMap(item => item.equipment ?? [])),
      serviceDurationMinutes: category?.serviceDurationMinutes ?? (selected.length === 1 ? selected[0].plannedDurationMinutes : undefined),
      durationSource: category?.serviceDurationMinutes != null ? category.durationSource : selected.length === 1 ? "version" : "", assignee: "", assigneeId: "" }));
  }

  return (
    <div className="request-editor-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="request-editor" role="dialog" aria-modal="true" aria-labelledby="request-editor-title">
        <form onSubmit={submit}>
          <header>
            <div><span className="request-editor-icon"><MaterialIcon name={editing ? "edit_note" : "note_add"} /></span><div><h2 id="request-editor-title">{editing ? "Редактирование заявки" : "Новая заявка"}</h2><p>{editing ? `#${initialRequest.number ?? "Без номера"}` : "Заполните основные данные заявки"}</p></div></div>
            <button type="button" aria-label="Закрыть форму" onClick={onClose}><MaterialIcon name="close" /></button>
          </header>

          <div className="request-editor-fields">
            <label className="full-field"><span>Номер заявки</span><input value={draft.number ?? ""} placeholder="Будет присвоен автоматически" readOnly /></label>
            {workCategories.length > 0 && <label className="full-field"><span>Тип ВК</span><select value={draft.categoryId ?? ""} onChange={event => selectComponents([], event.target.value)}>{!draft.categoryId && <option value="" disabled>Выберите ВК</option>}{workCategories.filter(item => item.active || item.id === draft.categoryId).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>}
            {draft.categoryId ? <fieldset className="full-field work-catalog-choices"><legend>Типы HD *</legend><div className="work-catalog-checks">{workTypes.filter(item => item.categoryIds?.includes(draft.categoryId!)).map(item => <label key={item.id}><input type="checkbox" checked={draft.workTypeIds?.includes(item.id) ?? false} onChange={event => selectComponents(event.target.checked ? [...draft.workTypeIds ?? [], item.id] : draft.workTypeIds?.filter(id => id !== item.id) ?? [])} />{item.name}</label>)}</div><small className="field-hint">Несколько HD выполняются в одном выезде.</small></fieldset> :
<label className="full-field"><span>Тип работ *</span><select value={draft.work} onChange={(event) => selectWorkType(event.target.value)} required><option value="" disabled>Выберите тип работ</option>{draft.work && !workTypes.some((workType) => workType.name === draft.work) && <option value={draft.work}>{draft.work}</option>}{workTypes.map((workType) => <option value={workType.name} key={workType.id}>{workType.name}</option>)}</select></label>}
            {(draft.workTypeIds?.length ?? 0) > 1 && <><label><span>Общий норматив обслуживания, мин *</span><input type="number" min={15} max={480} step={1} required value={draft.serviceDurationMinutes ?? ""} onChange={event => setDraft(current => ({ ...current, serviceDurationMinutes: event.target.value ? Number(event.target.value) : undefined }))} /></label><label><span>Источник общего норматива *</span><input required maxLength={2000} value={draft.durationSource ?? ""} onChange={event => setDraft(current => ({ ...current, durationSource: event.target.value }))} placeholder="Документ или согласованное значение" /></label><small className="field-hint full-field">Без дороги. Общие операции учитываются один раз.</small></>}
            <section className="full-field"><h3>Требуемое оборудование</h3>{draft.equipment?.length ? <ul>{draft.equipment.map(item => <li key={item.equipmentId}>{item.name} — {item.quantity === null ? "количество не задано" : `${item.quantity} ${item.unit}`}</li>)}</ul> : <p className="field-hint">Оборудование не указано в выбранных HD.</p>}</section>

            <label className="full-field"><span>Описание</span><textarea value={draft.description} onChange={(event) => setDraft((current) => ({ ...current, description: event.target.value }))} placeholder="Опишите задачу и ожидаемый результат" rows={4} /></label>
            <label><span>Приоритет *</span><select value={priority} disabled={isEmergency} onChange={(event) => setDraft((current) => ({ ...current, priority: event.target.value as RequestPriority | "" }))} required><option value="" disabled>Выберите приоритет</option><option value="high">Высокий</option><option value="medium">Средний</option><option value="low">Низкий</option></select></label>
            <label><span>Статус *</span><select value={draft.status} onChange={(event) => setDraft((current) => ({ ...current, status: event.target.value as RequestStatus | "" }))} required><option value="" disabled>Выберите статус</option><option value="new">Новая</option><option value="assigned">Назначена</option><option value="working">В работе</option><option value="paused" disabled={initialRequest?.status !== "paused"}>Приостановлена</option><option value="completed">Завершена</option><option value="cancelled">Отменена</option><option value="confirmed" disabled={initialRequest?.status !== "confirmed"}>Подтверждена</option></select>{initialRequest?.status === "paused" && <small className="field-hint">Исполнитель сообщил о проблеме. Для возобновления — «Продолжить» в мобильном приложении.</small>}</label>
            <label className="full-field"><span>Плановое начало работ *</span><input type="datetime-local" value={draft.dateTime} onChange={(event) => setDraft((current) => ({ ...current, dateTime: event.target.value }))} required />{serviceDuration && <small className="field-hint">Плановое время: {formatDuration(serviceDuration)}{plannedEnd ? `. Окончание: ${formatPlannedEnd(plannedEnd)}` : ""}.</small>}</label>
            <p className="field-hint full-field">Время заявки: {draft.schedulingTimezone || departmentTimezone || "регион подразделения"}. Клиентское окно ограничивает начало, а не окончание работ.</p>
            <label><span>Клиентское окно: с</span><input type="datetime-local" value={windowStart} readOnly={isEmergency} onChange={event => setDraft(current => ({ ...current, clientWindowStart: event.target.value }))} required={Boolean(windowEnd)} /></label>
            <label><span>Клиентское окно: до</span><input type="datetime-local" value={windowEnd} readOnly={isEmergency} min={windowStart || undefined} onChange={event => setDraft(current => ({ ...current, clientWindowEnd: event.target.value }))} required={Boolean(windowStart)} /></label>
            {isEmergency ? <small className="field-hint full-field">Срочная авария. Окно — календарные сутки региона, до полуночи следующего дня. Выполнить как можно раньше с учётом смены, компетенций и оборудования.</small> : !windowStart && <small className="field-hint full-field">Клиентское окно не задано. Уточните его перед распределением; длительность работ не определяет окно.</small>}
            <label className="client-confirmation-check full-field"><input type="checkbox" checked={draft.clientVisitConfirmed ?? false} onChange={event => setDraft(current => ({ ...current, clientVisitConfirmed: event.target.checked }))} /><span>Время визита подтверждено клиенту</span></label>
            {clientChange && <section className="client-approval-notice full-field" aria-label="Согласование изменения визита"><p>Меняется подтверждённый визит. До сохранения сообщите клиенту новое время, исполнителя или отмену.</p><label className="client-confirmation-check"><input type="checkbox" checked={clientNotified} onChange={event => setClientNotifiedKey(event.target.checked ? clientChangeKey : null)} /><span>Я сообщил клиенту об этих изменениях</span></label></section>}
            <label className="full-field"><span>Адрес *</span><input value={draft.address} onChange={(event) => changeAddress(event.target.value)} placeholder="Город, улица, дом" required /><small className={`geocoding-status ${geocoding.status}`}>{geocoding.status === "loading" ? "Определяем координаты…" : geocoding.status === "resolved" ? `Найдено: ${geocoding.formattedAddress}` : geocoding.status === "error" ? geocoding.message : "Координаты будут получены автоматически"}</small></label>
            <label className="full-field"><span>Адрес здания для маршрута</span><input value={draft.buildingAddress ?? ""} onChange={event => { resolvedAddressRef.current = ""; setDraft(current => ({ ...current, buildingAddress: event.target.value, point: null })); }} placeholder="Без квартиры; если пусто — используется адрес выше" /></label>
            <label><span>Квартира / офис</span><input value={draft.apartment ?? ""} maxLength={100} onChange={event => setDraft(current => ({ ...current, apartment: event.target.value }))} /></label>
            <label><span>Подъезд</span><input value={draft.entrance ?? ""} maxLength={100} onChange={event => setDraft(current => ({ ...current, entrance: event.target.value }))} /></label>
            <label><span>Домофон</span><input value={draft.intercom ?? ""} maxLength={100} onChange={event => setDraft(current => ({ ...current, intercom: event.target.value }))} /></label>
            <label><span>Широта (lat)</span><input value={draft.point?.lat.toFixed(6) ?? ""} placeholder="Определяется по адресу" readOnly aria-label="Широта, только чтение" /></label>
            <label><span>Долгота (lon)</span><input value={draft.point?.lon.toFixed(6) ?? ""} placeholder="Определяется по адресу" readOnly aria-label="Долгота, только чтение" /></label>
            <label className="full-field"><span>Исполнитель</span><select value={draft.assigneeId || engineers.find(item => item.name === draft.assignee)?.id || ""} onChange={event => { const engineer = engineers.find(item => item.id === event.target.value); setDraft(current => ({ ...current, assigneeId: engineer?.id ?? "", assignee: engineer?.name ?? "" })); }} disabled={!draft.work || eligibleEngineers.length === 0}><option value="">{!draft.work ? "Сначала выберите тип работ" : eligibleEngineers.length ? "Не назначен" : "Нет подходящих исполнителей"}</option>{draft.assigneeId && !eligibleEngineers.some(item => item.id === draft.assigneeId) && <option value={draft.assigneeId}>{draft.assignee} · проверьте компетенции</option>}{eligibleEngineers.map((engineer) => <option value={engineer.id} key={engineer.id}>{engineer.name}</option>)}</select><small className="field-hint">{draft.work ? `Соответствуют всем требованиям: ${eligibleEngineers.length}` : "Список формируется по навыкам и действующим допускам"}</small></label>
          {missingEquipment && <p className="schedule-conflict-text full-field" role="alert">{missingEquipment} Ручное назначение разрешено.</p>}
          {conflicts.length > 0 && <section className="request-scheduling-conflicts" role="alert" aria-label="Пересечения работ"><h3>Пересечение работ исполнителя</h3><ul>{conflicts.map(item => <li key={item.requestId}>{item.detail}</li>)}</ul></section>}
          {Boolean(initialRequest?.schedulingChanges?.length) && <section className="request-scheduling-history" aria-label="История назначений и времени"><h3>Назначения и время</h3><ul>{initialRequest!.schedulingChanges!.map(change => <li key={change.id}><strong>{change.reason}</strong><small>{new Intl.DateTimeFormat("ru-RU", { timeZone: draft.schedulingTimezone || departmentTimezone || "Europe/Moscow", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(change.createdAt))} · {change.actor}</small></li>)}</ul></section>}
          </div>

          {Boolean(initialRequest?.problemLog?.length) && <ProblemLog entries={initialRequest!.problemLog!} />}
          {(draft.status === "completed" || draft.status === "confirmed") && <section className="completion-report-section" aria-label="Отчёт о выполнении">
            <header><div><MaterialIcon name="fact_check" /><div><h3>Отчёт о выполнении</h3><p>Материалы, отправленные исполнителем из мобильного приложения</p></div></div><span className={draft.status === "confirmed" ? "report-review-status confirmed" : "report-review-status"}>{draft.status === "confirmed" ? "Подтверждено" : "Ожидает проверки"}</span></header>

            {draft.completionReport ? <div className="completion-report-content">
              <div className="completion-report-meta"><span><MaterialIcon name="person" /><b>{draft.completionReport.performer}</b></span><span><MaterialIcon name="schedule" />{draft.completionReport.submittedAt}</span></div>
              <div className="completion-comment"><small>Комментарий исполнителя</small><p>{draft.completionReport.comment}</p></div>
              {draft.completionReport.sections?.map(section=><div className="completion-comment" key={section.versionId}><strong>{section.name}</strong><small>Версия: {section.versionId} · Проверка: {section.verificationMode==='automatic' ? 'принимать автоматически' : section.verificationMode==='dispatcher' ? 'диспетчер' : section.verifierId ?? 'ИИ'}</small>{section.fields.map(field=><p key={field.id}><b>{field.label}: </b>{section.values[field.id] || 'Не заполнено'}</p>)}</div>)}
              <div className="completion-media"><small>Фото и видео ({draft.completionReport.media.length})</small><div>{draft.completionReport.media.map((media) => <article className={`completion-media-card ${media.kind}`} key={media.id}><span><MaterialIcon name={media.kind === "photo" ? "photo_camera" : "play_circle"} /></span><div><strong>{media.name}</strong><small>{media.kind === "photo" ? "Фотография" : "Видео"} · {media.meta}</small>{media.url ? <><a href={media.url} target="_blank" rel="noreferrer">Открыть материал</a>{media.kind === "video" && <ReportVideo url={media.url} name={media.name} />}</> : <small>Учебный пример · файл не загружен</small>}</div></article>)}</div></div>
              {draft.status === "completed" && <div className="completion-confirm-row"><p><MaterialIcon name="info" />После подтверждения заявка получит финальный статус.</p><button className="stitch-green-button" type="button" disabled={clientChange && !clientNotified} onClick={() => onSave({ ...draft, priority: draft.priority as RequestPriority, status: "confirmed", clientNotified })}><MaterialIcon name="verified" />Подтвердить выполнение</button></div>}
            </div> : <div className="completion-report-empty"><MaterialIcon name="hourglass_top" /><div><strong>Отчёт ещё не получен</strong><p>Исполнитель должен завершить работу и отправить комментарий с фото или видео из мобильного приложения.</p></div></div>}
          </section>}

          <footer><button className="request-cancel-button" type="button" onClick={onClose}>Отмена</button><button className="stitch-green-button" type="submit" disabled={!draft.point || geocoding.status === "loading" || (clientChange && !clientNotified)}><MaterialIcon name="save" />{editing ? "Сохранить изменения" : "Создать заявку"}</button></footer>
        </form>
      </section>
    </div>
  );
}

function ReportVideo({ url, name }: { url: string; name: string }) {
  // eslint-disable-next-line jsx-a11y/media-has-caption -- Executor-uploaded evidence has no caption track; do not fabricate one.
  return <video controls preload="metadata" src={url} style={{ width: "100%", maxHeight: "280px" }} aria-label={name} />;
}

function normalizeAddress(value: string) {
  return value.trim().replace(/\s+/g, " ");
}

function formatPlannedEnd(value: string) {
  const local = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/u.exec(value);
  return local ? `${local[3]}.${local[2]}.${local[1]} ${local[4]}:${local[5]}` : value;
}
