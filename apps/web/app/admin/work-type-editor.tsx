"use client";

import { useEffect, useState, type FormEvent } from "react";
import MaterialIcon from "@/app/components/material-icon";
import { DEFAULT_PLANNED_DURATION_MINUTES, MAX_PLANNED_DURATION_MINUTES, MIN_PLANNED_DURATION_MINUTES, isPlannedDurationMinutes } from "@/app/lib/planned-duration";
import { verificationMethods, type VerificationMethodId, type WorkTypeRecord } from "./work-type-data";

import { compareWorkCategories, type WorkCategory, type EquipmentItem } from "@/app/lib/work-catalog";

type WorkTypeDraft = Omit<WorkTypeRecord, "verificationMethodId"> & { verificationMethodId: VerificationMethodId | "" };

const emptyDraft: WorkTypeDraft = { id: "", name: "", description: "", plannedDurationMinutes: DEFAULT_PLANNED_DURATION_MINUTES, verificationMethodId: "", requiredSkills: [], requiredQualifications: [] };

type WorkTypeEditorProps = {
  workCategories?: WorkCategory[]; equipmentItems?: EquipmentItem[];
  initialWorkType: WorkTypeRecord | null;
  initialCategoryId?: string;
  onClose: () => void;
  onSave: (workType: WorkTypeRecord) => void | Promise<void>;
};

export default function WorkTypeEditor({ workCategories = [], initialWorkType, initialCategoryId, onClose, onSave }: WorkTypeEditorProps) {
  const [draft, setDraft] = useState<WorkTypeDraft>(initialWorkType ? { ...initialWorkType, requiredSkills: [...initialWorkType.requiredSkills], requiredQualifications: [...initialWorkType.requiredQualifications] } : { ...emptyDraft, categoryIds: initialCategoryId ? [initialCategoryId] : [] });
  const [requirementsError, setRequirementsError] = useState("");
  const editing = initialWorkType !== null;

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [onClose]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft.verificationMethodId) return;
    if (!isPlannedDurationMinutes(draft.plannedDurationMinutes)) return;
    if (!draft.categoryIds?.length) { setRequirementsError("Выберите тип ВК."); return; }
    onSave({ ...draft, name: draft.name.trim(), description: draft.description.trim(), verificationMethodId: draft.verificationMethodId,
      requiredSkillIds: [], requiredSkills: [], requiredQualificationIds: [], requiredQualifications: [] });
  }

  return (
    <div className="request-editor-backdrop work-type-editor-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="request-editor work-type-editor" role="dialog" aria-modal="true" aria-labelledby="work-type-editor-title">
        <form onSubmit={submit}>
          <header><div><span className="request-editor-icon"><MaterialIcon name={editing ? "edit_note" : "assignment_add"} /></span><div><h2 id="work-type-editor-title">{editing ? "Редактирование типа HD" : "Новый тип HD"}</h2><p>Правила выполнения и проверки отчёта</p></div></div><button type="button" aria-label="Закрыть форму" onClick={onClose}><MaterialIcon name="close" /></button></header>

          <div className="work-type-editor-fields">
            <section><h3>1. Тип ВК</h3><div className="work-catalog-checks">{workCategories.filter(item => item.active || draft.categoryIds?.includes(item.id)).sort(compareWorkCategories).map(item => <label key={item.id}><input type="checkbox" checked={draft.categoryIds?.includes(item.id) ?? false} onChange={event => setDraft(current => ({ ...current, categoryIds: event.target.checked ? [...current.categoryIds ?? [], item.id] : current.categoryIds?.filter(id => id !== item.id) ?? [] }))} />{item.name}</label>)}</div><small className="field-hint">Сначала выберите ВК. Ниже задаётся конкретная HD-работа; она может входить в несколько ВК.</small></section>
            <section><h3><MaterialIcon name="assignment" />2. Конкретная работа (HD)</h3><div className="work-type-editor-grid">
              <label><span>Название типа HD *</span><input value={draft.name} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value, isEmergency: event.target.value.trim().toLocaleLowerCase('ru')==='авария' || current.isEmergency }))} placeholder="Например, ремонт оборудования" required /></label>
              <label><span>Плановое время выполнения, мин *</span><input type="number" min={MIN_PLANNED_DURATION_MINUTES} max={MAX_PLANNED_DURATION_MINUTES} step={1} value={draft.plannedDurationMinutes} onChange={(event) => setDraft((current) => ({ ...current, plannedDurationMinutes: Number(event.target.value) }))} required /><small className="field-hint">Используется по умолчанию при создании заявки.</small></label>
              <label className="full-field"><span>Описание</span><textarea value={draft.description} onChange={(event) => setDraft((current) => ({ ...current, description: event.target.value }))} placeholder="Краткое описание состава и результата работ" rows={3} /></label>
              <label className="full-field catalog-inline-check"><input type="checkbox" checked={draft.isEmergency ?? false} onChange={event=>setDraft(current=>({...current,isEmergency:event.target.checked}))} />Срочная авария: окно на календарные сутки, выполнить как можно раньше</label>
            </div></section>

            <section><h3>Оборудование</h3><p>Состав оборудования задаётся у типа ВК в окне «Оборудование ВК».</p></section>

            <section><h3><MaterialIcon name="fact_check" />Проверка отчёта</h3><div className="work-type-editor-grid">
              <label className="full-field"><span>Тип проверки *</span><select value={draft.verificationMethodId} onChange={(event) => setDraft((current) => ({ ...current, verificationMethodId: event.target.value as VerificationMethodId }))} required><option value="" disabled>Выберите тип проверки</option>{verificationMethods.map((method) => <option value={method.id} key={method.id}>{method.label}</option>)}</select><small className="field-hint">{draft.verificationMethodId === 'automatic' ? 'Отчёт принимается после заполнения обязательных полей и загрузки материалов. Для составной заявки автоприём должен быть выбран у всех работ.' : 'ИИ-проверка анализирует комментарий исполнителя, фотографии и видео отчёта.'}</small></label>
            </div></section>

            <section><h3>Поля отчёта по этой работе</h3>
              <p className="field-hint">В составной заявке сохраняются поля каждой HD-работы. Общие фото и видео выезда должны удовлетворять требованиям каждой работы.</p>
              {(draft.reportTemplate?.fields ?? []).map((field,index)=><div className="work-type-editor-grid" key={field.id}>
                <label><span>Поле отчёта {index+1}</span><input required maxLength={150} value={field.label} onChange={event=>setDraft(current=>({...current,reportTemplate:{fields:current.reportTemplate!.fields.map(f=>f.id===field.id ? {...f,label:event.target.value} : f)}}))} /></label>
                <label><input type="checkbox" checked={field.required} onChange={event=>setDraft(current=>({...current,reportTemplate:{fields:current.reportTemplate!.fields.map(f=>f.id===field.id ? {...f,required:event.target.checked} : f)}}))} />Обязательное поле {index+1}</label>
                <button type="button" onClick={()=>setDraft(current=>({...current,reportTemplate:{fields:current.reportTemplate!.fields.filter(f=>f.id!==field.id)}}))}>Удалить поле {index+1}</button>
              </div>)}
              <button type="button" disabled={(draft.reportTemplate?.fields.length ?? 0)>=20} onClick={()=>setDraft(current=>({...current,reportTemplate:{fields:[...(current.reportTemplate?.fields ?? []),{id:crypto.randomUUID(),label:'',required:true}]}}))}>Добавить поле отчёта</button>
              <div className="work-type-editor-grid">
                <label><span>Минимум фотографий</span><input type="number" min={0} max={8-(draft.evidencePolicy?.minVideos ?? 0)} step={1} value={draft.evidencePolicy?.minPhotos ?? 0} onChange={event=>setDraft(current=>({...current,evidencePolicy:{minPhotos:Number(event.target.value),minVideos:current.evidencePolicy?.minVideos ?? 0}}))} /></label>
                <label><span>Минимум видео</span><input type="number" min={0} max={8-(draft.evidencePolicy?.minPhotos ?? 0)} step={1} value={draft.evidencePolicy?.minVideos ?? 0} onChange={event=>setDraft(current=>({...current,evidencePolicy:{minPhotos:current.evidencePolicy?.minPhotos ?? 0,minVideos:Number(event.target.value)}}))} /></label>
              </div>
              <small className="field-hint">На весь выезд нужен хотя бы один материал; общий предел — 8. Изменение создаёт новую версию и не меняет уже созданные заявки.</small>
            </section>

            {requirementsError && <p className="work-type-editor-error" role="alert">{requirementsError}</p>}

          </div>

          <footer><button className="request-cancel-button" type="button" onClick={onClose}>Отмена</button><button className="stitch-green-button" type="submit"><MaterialIcon name="save" />{editing ? "Сохранить изменения" : "Создать тип HD"}</button></footer>
        </form>
      </section>
    </div>
  );
}
