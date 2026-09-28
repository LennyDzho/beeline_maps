"use client";

import { useEffect, useState, type FormEvent } from "react";
import MaterialIcon from "@/app/components/material-icon";
import type { Vehicle, VehicleStatus } from "./resource-data";

type ResourceDraft = Omit<Vehicle, "type" | "status" | "condition"> & {
  type: Vehicle["type"] | "";
  status: VehicleStatus | "";
  condition: Vehicle["condition"] | "";
};

const emptyDraft: ResourceDraft = {
  id: "",
  name: "",
  type: "",
  plate: "",
  region: "",
  status: "",
  assignment: "",
  condition: "",
  serviceDate: "",
  vin: "",
  section: "",
  notes: "",
};

type ResourceEditorProps = {
  initialResource: Vehicle | null;
  engineers: Array<{ id: string; name: string }>;
  onClose: () => void;
  onSave: (resource: Vehicle) => void | Promise<void>;
};

export default function ResourceEditor({ initialResource, engineers, onClose, onSave }: ResourceEditorProps) {
  const [draft, setDraft] = useState<ResourceDraft>(initialResource ? {
    ...emptyDraft,
    ...initialResource,
    assignment: initialResource.assignment ?? "",
    serviceDate: initialResource.serviceDate ?? "",
    vin: initialResource.vin ?? "",
    section: initialResource.section ?? "",
    notes: initialResource.notes ?? "",
  } : emptyDraft);
  const editing = initialResource !== null;

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

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft.type || !draft.status || !draft.condition) return;
    onSave({
      ...draft,
      id: draft.id,
      name: draft.name.trim(),
      section: "",
      plate: draft.plate.trim().toUpperCase(),
      region: draft.region.trim(),
      vin: draft.vin?.trim().toUpperCase(),
      type: draft.type,
      status: draft.status,
      condition: draft.condition,
      assignment: draft.assignment || undefined,
      serviceDate: draft.condition === "service" ? draft.serviceDate : undefined,
    });
  }

  return (
    <div className="request-editor-backdrop resource-editor-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="request-editor resource-editor" role="dialog" aria-modal="true" aria-labelledby="resource-editor-title">
        <form onSubmit={submit}>
          <header>
            <div><span className="resource-editor-icon"><MaterialIcon name={editing ? "edit_note" : "add_box"} /></span><div><h2 id="resource-editor-title">{editing ? "Редактирование ресурса" : "Новый ресурс"}</h2><p>{editing ? `#${initialResource.id}` : "Добавление транспорта в реестр организации"}</p></div></div>
            <button type="button" aria-label="Закрыть форму" onClick={onClose}><MaterialIcon name="close" /></button>
          </header>

          <div className="resource-editor-fields">
            <section>
              <h3><MaterialIcon name="directions_car" />Основные данные</h3>
              <div className="resource-editor-grid">
                <label className="full-field"><span>Название / марка и модель *</span><input value={draft.name} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} placeholder="Например, Ford Transit" required /></label>
                <label><span>Тип транспорта *</span><select value={draft.type} onChange={(event) => setDraft((current) => ({ ...current, type: event.target.value as Vehicle["type"] | "" }))} required><option value="" disabled>Выберите тип</option><option value="Легковой">Легковой</option><option value="Фургон">Фургон</option></select></label>
                <label><span>Госномер *</span><input value={draft.plate} onChange={(event) => setDraft((current) => ({ ...current, plate: event.target.value }))} placeholder="А777АА" maxLength={9} required /></label>
                <label><span>Регион *</span><input inputMode="numeric" value={draft.region} onChange={(event) => setDraft((current) => ({ ...current, region: event.target.value.replace(/\D/gu, "").slice(0, 3) }))} placeholder="77" required /></label>
                <label className="full-field"><span>VIN</span><input value={draft.vin} onChange={(event) => setDraft((current) => ({ ...current, vin: event.target.value }))} placeholder="17 символов" maxLength={17} /></label>
              </div>
            </section>

            <section>
              <h3><MaterialIcon name="settings" />Эксплуатация и состояние</h3>
              <div className="resource-editor-grid">
                <label><span>Статус *</span><select value={draft.status} onChange={(event) => setDraft((current) => ({ ...current, status: event.target.value as VehicleStatus | "" }))} required><option value="" disabled>Выберите статус</option><option value="working">В работе</option><option value="repair">В ремонте</option><option value="available">Свободен</option></select></label>
                <label><span>Техническое состояние *</span><select value={draft.condition} onChange={(event) => setDraft((current) => ({ ...current, condition: event.target.value as Vehicle["condition"] | "", serviceDate: event.target.value === "service" ? current.serviceDate : "" }))} required><option value="" disabled>Выберите состояние</option><option value="Исправен">Исправен</option><option value="service">Требуется обслуживание</option></select></label>
                <label><span>Текущее назначение</span><select value={draft.assignment} onChange={(event) => setDraft((current) => ({ ...current, assignment: event.target.value }))}><option value="">Не назначен</option>{engineers.map((engineer) => <option value={engineer.name} key={engineer.id}>{engineer.name}</option>)}</select></label>
                <label><span>Дата следующего ТО{draft.condition === "service" ? " *" : ""}</span><input type="date" value={draft.serviceDate} onChange={(event) => setDraft((current) => ({ ...current, serviceDate: event.target.value }))} disabled={draft.condition !== "service"} required={draft.condition === "service"} /></label>
                <label className="full-field"><span>Примечание</span><textarea value={draft.notes} onChange={(event) => setDraft((current) => ({ ...current, notes: event.target.value }))} placeholder="Дополнительная информация о ресурсе" rows={3} /></label>
              </div>
            </section>
          </div>

          <footer><button className="resource-editor-cancel" type="button" onClick={onClose}>Отмена</button><button className="add-resource-button" type="submit"><MaterialIcon name="save" />{editing ? "Сохранить изменения" : "Добавить ресурс"}</button></footer>
        </form>
      </section>
    </div>
  );
}
