"use client";
import { useEffect, useState, type FormEvent } from "react";
import { apiRequest } from "@/app/lib/api-client";
import type { EquipmentItem, EquipmentSnapshot, WorkCategory } from "@/app/lib/work-catalog";

export default function CategoryEditor({ initialCategory, equipment, equipmentOnly, onCategorySaved, onEquipmentSaved, onClose }: {
  initialCategory: WorkCategory | null; equipment: EquipmentItem[]; equipmentOnly: boolean;
  onCategorySaved: (item: WorkCategory) => void; onEquipmentSaved: (item: EquipmentItem) => void; onClose: () => void;
}) {
  const [category, setCategory] = useState<WorkCategory>(initialCategory ?? { id: "", name: "", description: "", active: true, equipment: [] });
  const [links, setLinks] = useState<EquipmentSnapshot[]>(initialCategory?.equipment ?? []);
  const [item, setItem] = useState<EquipmentItem | null>(null);
  const [existingId, setExistingId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const escape = (e: KeyboardEvent) => { if (e.key === "Escape" && !busy) onClose(); };
    window.addEventListener("keydown", escape);
    return () => { document.body.style.overflow = previous; window.removeEventListener("keydown", escape); };
  }, [onClose, busy]);
  async function saveCategory(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    try {
      const { id, name, description, active, serviceDurationMinutes } = category;
      const result = await apiRequest<{ item: WorkCategory }>("/api/admin/work-categories", { method: id ? "PUT" : "POST", body: JSON.stringify({ id, name, description, active, serviceDurationMinutes, ...(equipmentOnly || !id ? { equipment: links.map(({equipmentId, quantity})=>({equipmentId,quantity})) } : {}) }) });
      onCategorySaved(result.item); onClose();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Не удалось сохранить."); }
    finally { setBusy(false); }
  }
  async function saveItem(event: FormEvent) {
    event.preventDefault(); if (!item) return; setBusy(true); setError("");
    try {
      const {item:saved} = await apiRequest<{ item: EquipmentItem }>("/api/admin/equipment", { method: item.id ? "PUT" : "POST", body: JSON.stringify(item) });
      onEquipmentSaved(saved);
      setLinks(current => current.some(e=>e.equipmentId===saved.id) ? current.map(e=>e.equipmentId===saved.id ? {...e,name:saved.name,unit:saved.unit,usage:saved.usage} : e) : [...current,{equipmentId:saved.id,name:saved.name,unit:saved.unit,usage:saved.usage,quantity:null}]);
      setItem(null);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Не удалось сохранить оборудование."); }
    finally { setBusy(false); }
  }
  return <div className="request-editor-backdrop" role="presentation" onMouseDown={e=>{if(e.target===e.currentTarget && !busy) onClose();}}>
    <section className="request-editor work-type-editor category-editor" role="dialog" aria-modal="true" aria-labelledby="category-editor-title">
      <header><h2 id="category-editor-title">{equipmentOnly ? `Оборудование ВК · ${category.name}` : category.id ? "Редактирование типа ВК" : "Новый тип ВК"}</h2><button type="button" aria-label="Закрыть форму" disabled={busy} onClick={onClose}>×</button></header>
      <div className="work-type-editor-fields category-editor-fields">
        {error && <p role="alert">{error}</p>}
        <form id="category-form" onSubmit={saveCategory}>
          {!equipmentOnly && <>
            <label>Название ВК<input required maxLength={200} value={category.name} onChange={e=>setCategory({...category,name:e.target.value})} /></label>
            <label>Описание<textarea aria-label="Описание" maxLength={2000} value={category.description} onChange={e=>setCategory({...category,description:e.target.value})} /></label>
            <label>Норматив ВК без дороги, мин<input type="number" min={15} max={480} step={1} value={category.serviceDurationMinutes ?? ""} onChange={e=>setCategory({...category,serviceDurationMinutes:e.target.value ? Number(e.target.value) : null})} placeholder="По типу HD" /></label>
            <small>Норматив применяется один раз на выезд. Сохранённые заявки сохраняют прежний норматив.</small>
            <label className="catalog-inline-check"><input type="checkbox" checked={category.active} onChange={e=>setCategory({...category,active:e.target.checked})} />Действует</label>
          </>}
          {equipmentOnly && <>
            <p>Оборудование для одного выезда по этому ВК. Изменения применяются к новым заявкам.</p>
            {links.length === 0 && <p>Оборудование пока не добавлено.</p>}
            {links.map(link=><div className="category-equipment-row" key={link.equipmentId}>
              <strong>{link.name}{link.unit ? ` · ${link.unit}` : ""}</strong>
              <label>Количество<input aria-label={`Количество: ${link.name}`} type="number" min="0.001" max="1000000" step="any" value={link.quantity ?? ""} placeholder="Не задано" onChange={e=>setLinks(current=>current.map(row=>row.equipmentId===link.equipmentId ? {...row,quantity:e.target.value ? Number(e.target.value) : null} : row))} /></label>
              <button type="button" disabled={busy} onClick={()=>setItem(equipment.find(e=>e.id===link.equipmentId) ?? {...link,id:link.equipmentId,active:true})}>Редактировать {link.name}</button>
              <button type="button" disabled={busy} onClick={()=>setLinks(current=>current.filter(e=>e.equipmentId!==link.equipmentId))}>Убрать из ВК: {link.name}</button>
            </div>)}
            <label>Добавить из справочника<select aria-label="Добавить из справочника" value={existingId} onChange={e=>setExistingId(e.target.value)}><option value="">Выберите оборудование</option>{equipment.filter(e=>e.active && !links.some(l=>l.equipmentId===e.id)).map(e=><option key={e.id} value={e.id}>{e.name}</option>)}</select></label>
            <button type="button" disabled={!existingId || busy} onClick={()=>{const e=equipment.find(e=>e.id===existingId);if(e) setLinks(current=>[...current,{equipmentId:e.id,name:e.name,unit:e.unit,usage:e.usage,quantity:null}]);setExistingId("");}}>Добавить в ВК</button>
            <button type="button" disabled={busy} onClick={()=>setItem({id:"",name:"",unit:"",usage:"unspecified",active:true})}>Новое оборудование</button>
          </>}
        </form>
        {item && <form className="category-equipment-editor" onSubmit={saveItem}>
          <h3>{item.id ? "Редактирование оборудования" : "Новое оборудование"}</h3>
          {item.id && <small>Название и единица измерения обновятся во всех ВК, где используется это оборудование.</small>}
          <label>Название оборудования<input required maxLength={200} value={item.name} onChange={e=>setItem({...item,name:e.target.value})} /></label>
          <label>Единица измерения<input maxLength={50} value={item.unit} onChange={e=>setItem({...item,unit:e.target.value})} /></label>
          <label>Использование<select aria-label="Использование" value={item.usage} onChange={e=>setItem({...item,usage:e.target.value as EquipmentItem["usage"]})}><option value="unspecified">Не определено</option><option value="consumable">Расходуется</option><option value="reusable">Используется повторно</option></select></label>
          <button type="submit" disabled={busy}>Сохранить оборудование</button><button type="button" disabled={busy} onClick={()=>setItem(null)}>Отменить редактирование</button>
        </form>}
      </div>
      <footer><button type="button" disabled={busy} onClick={onClose}>Отмена</button><button className="stitch-green-button" form="category-form" type="submit" disabled={busy || Boolean(item)}>{equipmentOnly ? "Сохранить список оборудования" : "Сохранить ВК"}</button></footer>
    </section>
  </div>;
}
