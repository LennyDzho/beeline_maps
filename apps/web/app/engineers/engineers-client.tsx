"use client";

import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import type { AuthUser } from "@/auth/session";
import MaterialIcon from "@/app/components/material-icon";
import Pagination from "@/app/components/pagination";
import DispatcherSectionShell from "@/app/dispatcher/section-shell";
import { usePagination } from "@/app/hooks/use-pagination";
import { apiRequest } from "@/app/lib/api-client";
import EngineerEditor, { type EngineerVehicle, type EngineerRecord, type ShiftStatus } from "./engineer-editor";
import type { WorkScheduleRecord } from "@/app/admin/work-schedule-data";

type EditorState = { mode: "create" } | { mode: "edit"; engineer: EngineerRecord };

const statusLabels: Record<ShiftStatus, string> = { on_shift: "В смене", break: "На перерыве", off_shift: "Не в смене" };
const statusIcons: Record<ShiftStatus, string> = { on_shift: "directions_run", break: "local_cafe", off_shift: "hotel" };
const transportIcons = { car: "directions_car", transit: "directions_transit" } as const;

export default function EngineersClient({ user }: { user: AuthUser }) {
  const [vehicles, setVehicles] = useState<EngineerVehicle[]>([]);
  const [rows, setRows] = useState<EngineerRecord[]>([]);
  const [users, setUsers] = useState<Array<{ id: string; name: string; email: string }>>([]);
  const [schedules, setSchedules] = useState<WorkScheduleRecord[]>([]);
  const [workCategories, setWorkCategories] = useState<import("@/app/lib/work-catalog").WorkCategory[]>([]);
  const [workTypes, setWorkTypes] = useState<import("@/app/admin/work-type-data").WorkTypeRecord[]>([]);
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [hdFilter, setHdFilter] = useState("all");
  const [status, setStatus] = useState<"all" | ShiftStatus>("all");
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [notice, setNotice] = useState("");

  const visibleEngineers = useMemo(() => rows.filter((engineer) => {
    const statusMatch = status === "all" || engineer.status === status;
    const skillMatch = (engineer.workCompetencies ?? []).some(c => (categoryFilter === "all" || c.categoryId === categoryFilter) && (hdFilter === "all" || c.workTypeId === hdFilter)) || (categoryFilter === "all" && hdFilter === "all");
    return statusMatch && skillMatch;
  }), [rows, categoryFilter, hdFilter, status]);
  const pagination = usePagination(visibleEngineers, 3);

  useEffect(() => {
    let active = true;
    apiRequest<{ vehicles: EngineerVehicle[]; items: EngineerRecord[]; users: Array<{ id: string; name: string; email: string }>; schedules: WorkScheduleRecord[]; workCategories: import("@/app/lib/work-catalog").WorkCategory[]; workTypes: import("@/app/admin/work-type-data").WorkTypeRecord[] }>("/api/engineers")
      .then((data) => { if (active) { setRows(data.items); setVehicles(data.vehicles); setUsers(data.users); setSchedules(data.schedules); setWorkTypes(data.workTypes); setWorkCategories(data.workCategories); } })
      .catch((error: Error) => { if (active) setNotice(error.message); });
    return () => { active = false; };
  }, []);

  function showNotice(message: string) {
    setNotice(message);
    window.setTimeout(() => setNotice(""), 4000);
  }

  function openEditEditor(engineer: EngineerRecord) {
    setEditor({ mode: "edit", engineer });
  }

  function handleRowKeyDown(event: KeyboardEvent<HTMLTableRowElement>, engineer: EngineerRecord) {
    if ((event.key === "Enter" || event.key === " ") && event.target === event.currentTarget) {
      event.preventDefault();
      openEditEditor(engineer);
    }
  }

  async function saveEngineer(engineer: EngineerRecord) {
    try {
      const editing = editor?.mode === "edit";
      const payload = editing ? { ...engineer, id: editor.engineer.id } : engineer;
      const data = await apiRequest<{ item: EngineerRecord; vehicles: EngineerVehicle[] }>("/api/engineers", { method: editing ? "PUT" : "POST", body: JSON.stringify(payload) });
      setRows((current) => editing ? current.map((item) => item.id === data.item.id ? data.item : item) : [data.item, ...current]);
      setVehicles(data.vehicles);
      if (!editing) { setStatus("all"); setCategoryFilter("all"); setHdFilter("all"); pagination.resetPage(); }
      showNotice(editing ? `Данные сотрудника № ${data.item.employeeNumber} обновлены.` : `Исполнитель № ${data.item.employeeNumber} создан.`);
      setEditor(null);
    } catch (error) { showNotice(error instanceof Error ? error.message : "Не удалось сохранить исполнителя."); }
  }

  return (
    <DispatcherSectionShell user={user} active="engineers" className="engineers-shell">
      <main className="desktop-section engineers-page">
        <header className="section-heading action-heading">
          <div><h1>Исполнители</h1><p>Управление выездным персоналом и назначениями</p></div>
          <button className="stitch-green-button" type="button" onClick={() => setEditor({ mode: "create" })}><MaterialIcon name="add" />Создать исполнителя</button>
        </header>

        <section className="engineer-metrics" aria-label="Сводка по исполнителям">
          <article><div><MaterialIcon name="group" /><small>Всего сотрудников</small></div><strong>{rows.length}</strong></article>
          <article className="green"><div><MaterialIcon name="work" /><small>В смене</small></div><strong>{rows.filter((item) => item.status === "on_shift").length} <span>{rows.length ? Math.round(rows.filter((item) => item.status === "on_shift").length / rows.length * 100) : 0}%</span></strong></article>
          <article className="gold"><div><MaterialIcon name="event_available" /><small>Доступны</small></div><strong>{rows.filter((item) => item.status === "on_shift" && item.load < 100).length}</strong></article>
        </section>

        <section className="stitch-table-card engineers-table-card" aria-label="Список исполнителей">
          <div className="engineer-filterbar">
            <div>
              <label><span className="sr-only">Статус</span><select value={status} onChange={(event) => { setStatus(event.target.value as "all" | ShiftStatus); pagination.resetPage(); }}><option value="all">Все статусы</option><option value="on_shift">В смене</option><option value="off_shift">Не в смене</option><option value="break">На перерыве</option></select></label>
              <label><span className="sr-only">Тип ВК</span><select value={categoryFilter} onChange={event=>{setCategoryFilter(event.target.value);setHdFilter("all");pagination.resetPage();}}><option value="all">Все ВК</option>{workCategories.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
              <label><span className="sr-only">Тип HD</span><select value={hdFilter} onChange={event=>{setHdFilter(event.target.value);pagination.resetPage();}}><option value="all">Все HD</option>{workTypes.filter(t=>categoryFilter==="all" || t.categoryIds?.includes(categoryFilter)).map(t=><option key={t.id} value={t.id}>{t.name}</option>)}</select></label>
            </div>
            <div className="engineer-view-actions"><button type="button" aria-label="Сбросить фильтры" onClick={() => { setStatus("all"); setCategoryFilter("all"); setHdFilter("all"); pagination.resetPage(); }}><MaterialIcon name="filter_alt_off" /></button><button type="button" aria-label="Настроить столбцы"><MaterialIcon name="view_column" /></button></div>
          </div>
          <div className="table-scroll">
            <table className="stitch-data-table engineers-table">
              <thead><tr><th>Сотрудник</th><th>Статус</th><th>Рабочий график</th><th>Компетенции ВК–HD</th><th>Загрузка</th><th>Транспорт</th><th>Действия</th></tr></thead>
              <tbody>
                {pagination.pageItems.map((engineer) => (
                  <tr className="engineer-row" role="button" tabIndex={0} aria-label={`Редактировать исполнителя ${engineer.name}`} onClick={() => openEditEditor(engineer)} onKeyDown={(event) => handleRowKeyDown(event, engineer)} key={engineer.id}>
                    <td><div className="employee-cell"><span className={`employee-avatar ${engineer.status}`}>{engineer.initials}</span><div><strong>{engineer.name}</strong><small>№ {engineer.employeeNumber}</small></div></div></td>
                    <td><span className={`shift-status ${engineer.status}`}><MaterialIcon name={statusIcons[engineer.status]} />{statusLabels[engineer.status]}</span></td>
                    <td><span className="engineer-schedule-cell"><MaterialIcon name="calendar_month" />{engineer.workScheduleName}</span></td>
                    <td><div className="skill-chips">{(engineer.workCompetencies ?? []).map(c=><span key={c.categoryId+":"+c.workTypeId}>{workCategories.find(v=>v.id===c.categoryId)?.name} → {workTypes.find(t=>t.id===c.workTypeId)?.name}</span>)}{!engineer.workCompetencies?.length && <span>Не выбраны</span>}</div></td>
                    <td><div className={`load-cell ${engineer.status}`}><i><b style={{ width: `${engineer.load}%` }} /></i><span>{engineer.load}%</span></div></td>
                    <td><span className="transport-cell"><MaterialIcon name={transportIcons[engineer.transportType]} />{engineer.transport}</span></td>
                    <td><div className="employee-actions"><button type="button" aria-label={`Отправить сообщение: ${engineer.name}`} onClick={(event) => { event.stopPropagation(); showNotice("Чат с исполнителем будет добавлен отдельным модулем."); }}><MaterialIcon name="send" /></button><button type="button" aria-label={`Редактировать: ${engineer.name}`} onClick={(event) => { event.stopPropagation(); openEditEditor(engineer); }}><MaterialIcon name="edit" /></button></div></td>
                  </tr>
                ))}
                {pagination.pageItems.length === 0 && <tr><td className="empty-row" colSpan={7}>Исполнители по выбранным фильтрам не найдены</td></tr>}
              </tbody>
            </table>
          </div>
          <footer className="full-table-footer"><Pagination page={pagination.page} pageCount={pagination.pageCount} pageSize={3} totalItems={visibleEngineers.length} itemLabel="исполнителей" onPageChange={pagination.setPage} /></footer>
        </section>
      </main>

      {editor && <EngineerEditor vehicles={vehicles} workCategories={workCategories} workTypes={workTypes} initialEngineer={editor.mode === "edit" ? editor.engineer : null} users={users} schedules={schedules} onClose={() => setEditor(null)} onSave={saveEngineer} />}
      {notice && <div className="resource-notice" role="status">{notice}</div>}
    </DispatcherSectionShell>
  );
}
