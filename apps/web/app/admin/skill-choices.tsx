"use client";

import type { SkillRecord } from "./skill-data";

export default function SkillChoices({ items, selectedIds, retainedIds = [], onChange }: {
  items: SkillRecord[]; selectedIds: string[]; retainedIds?: string[]; onChange: (ids: string[]) => void;
}) {
  const options = items.filter((item) => item.active || retainedIds.includes(item.id));
  return <div className="requirement-group qualification-choices">
    <div><b>Необходимые навыки *</b><small>Выберите один или несколько</small></div>
    <div className="requirement-options">{options.map((item) => <label className={selectedIds.includes(item.id) ? "checked" : ""} key={item.id}>
      <input type="checkbox" checked={selectedIds.includes(item.id)} onChange={() => onChange(selectedIds.includes(item.id) ? selectedIds.filter((id) => id !== item.id) : [...selectedIds, item.id])} />
      <span>{item.name}{!item.active && " (отключён)"}</span>
    </label>)}</div>
    {!options.length && <p className="field-hint">Нет доступных навыков. Добавьте их в разделе «Администрирование → Навыки и допуски».</p>}
    {selectedIds.some((id) => !items.some((item) => item.id === id)) && <p role="alert" className="work-type-editor-error">Справочник изменился. Закройте форму и обновите страницу перед сохранением.</p>}
  </div>;
}
