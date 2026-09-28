"use client";

import { useState } from "react";
import type { WorkCategory, WorkCompetency } from "@/app/lib/work-catalog";

export default function WorkCompetencyChoices({ categories, workTypes, value, onChange }: {
  categories: WorkCategory[]; workTypes: { id: string; name: string; categoryIds?: string[] }[];
  value: WorkCompetency[]; onChange: (value: WorkCompetency[]) => void;
}) {
  const [categoryId, setCategoryId] = useState(value[0]?.categoryId ?? categories.find(item => item.active)?.id ?? "");
  return <fieldset className="work-catalog-choices"><legend>Компетенции ВК → HD</legend>
    <label><span>Тип ВК</span><select value={categoryId} onChange={event => setCategoryId(event.target.value)}><option value="">Выберите ВК</option>{categories.map(item => <option key={item.id} value={item.id}>{item.name}{item.active ? "" : " (отключён)"}</option>)}</select></label>
    <div className="work-catalog-checks">{workTypes.filter(item => item.categoryIds?.includes(categoryId)).map(item => <label key={item.id}>
      <input type="checkbox" checked={value.some(link => link.categoryId === categoryId && link.workTypeId === item.id)} onChange={event => onChange(event.target.checked
        ? [...value, { categoryId, workTypeId: item.id }] : value.filter(link => !(link.categoryId === categoryId && link.workTypeId === item.id)))} />{item.name}
    </label>)}</div>
    <small className="field-hint">Выбрано HD: {value.length}. При смене ВК остальные компетенции сохраняются.</small>
  </fieldset>;
}
