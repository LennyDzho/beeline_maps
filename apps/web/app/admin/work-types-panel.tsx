"use client";

import { useState, type KeyboardEvent } from "react";
import MaterialIcon from "@/app/components/material-icon";
import Pagination from "@/app/components/pagination";
import { usePagination } from "@/app/hooks/use-pagination";
import { formatDuration } from "@/app/lib/planned-duration";
import { getVerificationMethod, type WorkTypeRecord } from "./work-type-data";
import { compareWorkCategories, type WorkCategory } from "@/app/lib/work-catalog";

type WorkTypesPanelProps = {
  workTypes: WorkTypeRecord[];
  categories?: WorkCategory[];
  onCategoryEdit: (category: WorkCategory | null, equipmentOnly: boolean) => void;
  onCreate: (categoryId: string) => void;
  onEdit: (workType: WorkTypeRecord) => void;
};

export default function WorkTypesPanel({ workTypes, categories = [], onCreate, onEdit, onCategoryEdit }: WorkTypesPanelProps) {
  const groups = [...categories].sort(compareWorkCategories);
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  const categoryId = selectedCategory ?? groups[0]?.id ?? "";
  const visibleTypes = categoryId ? workTypes.filter(item => item.categoryIds?.includes(categoryId)) : workTypes.filter(item => !item.categoryIds?.length);
  const pagination = usePagination(visibleTypes, 4);

  function handleKeyDown(event: KeyboardEvent<HTMLTableRowElement>, workType: WorkTypeRecord) {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onEdit(workType);
    }
  }

  return (
    <section className="stitch-table-card work-types-card" aria-label="Типы заявок">
      <header className="work-types-card-header"><div><MaterialIcon name="assignment" /><div><h2>Типы заявок</h2><p>Общий для всех подразделений · ВК → конкретные работы HD</p></div></div><span>{visibleTypes.length} HD</span></header>
      {groups.length > 0 && <div className="work-types-category-filter"><label>Тип ВК<select value={categoryId} onChange={event=>{setSelectedCategory(event.target.value);pagination.setPage(1);}}>{groups.map(item=><option value={item.id} key={item.id}>{item.name}{item.active ? '' : ' · отключён'}</option>)}{workTypes.some(item=>!item.categoryIds?.length) && <option value="">Без ВК</option>}</select></label><p>Выберите ВК, затем откройте нужный тип HD.</p><button className="stitch-green-button" type="button" disabled={!categoryId} onClick={() => onCreate(categoryId)}>Добавить тип HD</button><button type="button" disabled={!categoryId} onClick={()=>onCategoryEdit(groups.find(c=>c.id===categoryId)!,true)}>Оборудование ВК</button><button type="button" disabled={!categoryId} onClick={()=>onCategoryEdit(groups.find(c=>c.id===categoryId)!,false)}>Редактировать ВК</button></div>}
      <div className="catalog-add-category"><button type="button" onClick={()=>onCategoryEdit(null,false)}>Добавить тип ВК</button></div>
      <div className="table-scroll">
        <table className="stitch-data-table work-types-table">
          <thead><tr><th>Тип HD</th><th>Плановое время</th><th>Проверка отчёта</th><th>Действия</th></tr></thead>
          <tbody>{pagination.pageItems.map((workType) => {
            const verification = getVerificationMethod(workType.verificationMethodId);
            return <tr className="work-type-row" key={workType.id} tabIndex={0} aria-label={`Редактировать тип HD ${workType.name}`} onClick={() => onEdit(workType)} onKeyDown={(event) => handleKeyDown(event, workType)}>
              <td><div className="work-type-name"><span><MaterialIcon name="assignment" /></span><div><strong>{workType.name}</strong></div></div></td>
              <td><span className="work-duration-chip"><MaterialIcon name="schedule" />{formatDuration(workType.plannedDurationMinutes)}</span></td>
              <td><span className={`verification-chip ${verification.kind}`}><MaterialIcon name={verification.kind === "ai" ? "smart_toy" : verification.kind === "automatic" ? "task_alt" : "support_agent"} />{verification.label}</span></td>
              <td><button className="table-action visible-action" type="button" aria-label={`Редактировать тип HD ${workType.name}`} onClick={(event) => { event.stopPropagation(); onEdit(workType); }}><MaterialIcon name="edit" /></button></td>
            </tr>;
          })}</tbody>
        </table>
      </div>
      <footer className="compact-table-footer"><Pagination page={pagination.page} pageCount={pagination.pageCount} pageSize={4} totalItems={visibleTypes.length} itemLabel="работ HD" onPageChange={pagination.setPage} /></footer>
    </section>
  );
}
