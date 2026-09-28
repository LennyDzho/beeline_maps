"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import MaterialIcon from "@/app/components/material-icon";
import { apiRequest } from "@/app/lib/api-client";
import type { SkillInput, SkillRecord } from "./skill-data";

const catalogLabels = {
  qualifications: { title: "Допуски и квалификации", empty: "Допусков пока нет.", edit: "Редактирование допуска", create: "Новый допуск / квалификация", placeholder: "Например, работы на высоте", icon: "verified" },
  skills: { title: "Навыки", empty: "Навыков пока нет.", edit: "Редактирование навыка", create: "Новый навык", placeholder: "Например, обслуживание кондиционеров", icon: "engineering" },
};
type CatalogKind = keyof typeof catalogLabels;

export default function RequirementCatalogPanel<T extends SkillRecord>({ items, ready, onSaved, kind }: {
  items: T[];
  ready: boolean;
  onSaved: (item: T) => void;
  kind: CatalogKind;
}) {
  const [editor, setEditor] = useState<{ item: T | null } | null>(null);
  const labels = catalogLabels[kind];
  return <section className="qualifications-card" aria-label={`Справочник: ${labels.title}`}>
    <header><div><h2>{labels.title}</h2><p>Общий справочник для типов работ и исполнителей выбранного юрлица.</p></div>
      <button type="button" className="stitch-green-button" disabled={!ready} onClick={() => setEditor({ item: null })}><MaterialIcon name="add" />{kind === "skills" ? "Добавить навык" : "Добавить допуск"}</button>
    </header>
    {!ready ? <p className="qualifications-empty" role="status">Справочник ещё не загружен.</p> : !items.length ? <p className="qualifications-empty">{labels.empty} Добавьте первую запись.</p> :
      <div className="qualifications-table-scroll"><table className="qualifications-table"><thead><tr><th>Название и описание</th><th>Использование</th><th>Статус</th><th><span className="sr-only">Действия</span></th></tr></thead><tbody>
        {[...items].sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name, "ru")).map((item) => <tr key={item.id}>
          <td><b>{item.name}</b>{item.description && <p>{item.description}</p>}</td>
          <td><span>Исполнителей: {item.workerCount}</span><br /><span>Типов работ: {item.workTypeCount}</span></td>
          <td><span className={`qualification-status ${item.active ? "active" : ""}`}>{item.active ? "Активен" : "Отключён"}</span></td>
          <td><button className="qualification-edit-button" type="button" aria-label={`Редактировать: ${item.name}`} onClick={() => setEditor({ item })}><MaterialIcon name="edit" /></button></td>
        </tr>)}
      </tbody></table></div>}
    <p className="qualifications-note">Переименование сохраняет все связи. Отключение доступно только для неиспользуемых записей. Учитываются также предыдущие версии типов работ.</p>
    {editor && <CatalogEditor initial={editor.item} kind={kind} onClose={() => setEditor(null)} onSaved={onSaved} />}
  </section>;
}

function CatalogEditor<T extends SkillRecord>({ initial, kind, onClose, onSaved }: {
  initial: T | null;
  kind: CatalogKind;
  onClose: () => void;
  onSaved: (item: T) => void;
}) {
  const [draft, setDraft] = useState<SkillInput>(initial ?? { name: "", description: "", active: true });
  const labels = catalogLabels[kind];
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const busyRef = useRef(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const inUse = Boolean(initial && (initial.workerCount || initial.workTypeCount));

  useEffect(() => {
    const overflow = document.body.style.overflow;
    const previousFocus = document.activeElement;
    nameRef.current?.focus();
    document.body.style.overflow = "hidden";
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape" && !busyRef.current) onClose(); };
    window.addEventListener("keydown", escape);
    return () => {
      document.body.style.overflow = overflow;
      window.removeEventListener("keydown", escape);
      if (previousFocus instanceof HTMLElement) previousFocus.focus();
    };
  }, [onClose]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busyRef.current) return;
    busyRef.current = true;
    setSaving(true);
    setError("");
    try {
      const result = await apiRequest<{ item: T }>(`/api/admin/${kind}`, {
        method: initial ? "PUT" : "POST",
        body: JSON.stringify({ name: draft.name, description: draft.description, active: draft.active, ...(initial ? { id: initial.id } : {}) }),
      });
      onSaved(result.item);
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Не удалось сохранить запись.");
    } finally { busyRef.current = false; setSaving(false); }
  }

  return <div className="request-editor-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !saving) onClose(); }}>
    <section className="request-editor qualification-editor" role="dialog" aria-modal="true" aria-labelledby={`${kind}-editor-title`}>
      <form onSubmit={submit}>
        <header><div><span className="request-editor-icon"><MaterialIcon name={labels.icon} /></span><div><h2 id={`${kind}-editor-title`}>{initial ? labels.edit : labels.create}</h2><p>Справочник выбранного юрлица</p></div></div><button type="button" aria-label="Закрыть форму" onClick={onClose} disabled={saving}><MaterialIcon name="close" /></button></header>
        <div className="qualification-editor-fields">
          <label><span>Название *</span><input ref={nameRef} required maxLength={200} value={draft.name} disabled={saving} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder={labels.placeholder} /></label>
          <label><span>Описание</span><textarea rows={4} maxLength={2000} value={draft.description} disabled={saving} onChange={(event) => setDraft({ ...draft, description: event.target.value })} /></label>
          <label className="qualification-active-check"><input type="checkbox" checked={draft.active} disabled={saving || (inUse && Boolean(initial?.active))} onChange={(event) => setDraft({ ...draft, active: event.target.checked })} /><span>Активен — доступен для выбора в формах</span></label>
          {inUse && <p className="field-hint">Запись используется: исполнителей — {initial!.workerCount}, типов работ — {initial!.workTypeCount}. Название и описание можно изменять; отключение недоступно.</p>}
          {error && <p className="work-type-editor-error" role="alert">{error}</p>}
        </div>
        <footer><button type="button" className="request-cancel-button" disabled={saving} onClick={onClose}>Отмена</button><button type="submit" className="stitch-green-button" disabled={saving || !draft.name.trim()}><MaterialIcon name="save" />{saving ? "Сохранение…" : "Сохранить"}</button></footer>
      </form>
    </section>
  </div>;
}
