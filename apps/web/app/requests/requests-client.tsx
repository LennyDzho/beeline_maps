"use client";

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { AuthUser } from "@/auth/session";
import MaterialIcon from "@/app/components/material-icon";
import Pagination from "@/app/components/pagination";
import DispatcherSectionShell from "@/app/dispatcher/section-shell";
import { usePagination } from "@/app/hooks/use-pagination";
import { apiRequest } from "@/app/lib/api-client";
import RequestEditor, { type RequestEngineer, type RequestItem, type RequestPriority, type RequestStatus, type RequestWorkType } from "./request-editor";
import { problemTime } from "./problem-log";

type EditorState = { mode: "create" } | { mode: "edit"; request: RequestItem };

const filters: Array<{ id: "all" | RequestStatus; label: string }> = [
  { id: "all", label: "Все заявки" },
  { id: "new", label: "Новые" },
  { id: "assigned", label: "Назначены" },
  { id: "working", label: "В работе" },
  { id: "paused", label: "Приостановлены" },
  { id: "completed", label: "Завершены" },
  { id: "confirmed", label: "Подтверждены" },
  { id: "cancelled", label: "Отменены" },
];

const priorityLabels: Record<RequestPriority, string> = { high: "Высокий", medium: "Средний", low: "Низкий" };
const statusLabels: Record<RequestStatus, string> = { new: "Новая", assigned: "Назначена", working: "В работе", paused: "Приостановлена", completed: "Завершена", confirmed: "Подтверждена", cancelled: "Отменена" };

export default function RequestsClient({ user }: { user: AuthUser }) {
  const openedFromNotice = useRef(false);
  const [filter, setFilter] = useState<(typeof filters)[number]["id"]>("all");
  const [rows, setRows] = useState<RequestItem[]>([]);
  const [departmentTimezone, setDepartmentTimezone] = useState("");
  const [workCategories, setWorkCategories] = useState<import("@/app/lib/work-catalog").WorkCategory[]>([]);
  const [workTypes, setWorkTypes] = useState<RequestWorkType[]>([]);
  const [engineers, setEngineers] = useState<RequestEngineer[]>([]);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [notice, setNotice] = useState("");
  const [view, setView] = useState<"requests" | "problems">("requests");
  const problemEntries = useMemo(() => rows.flatMap(request => (request.problemLog ?? []).map(problem => ({ ...problem, request })))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id)), [rows]);
  const problemsPagination = usePagination(problemEntries, 10);
  const visibleRequests = useMemo(() => rows.filter((request) => filter === "all" || request.status === filter), [filter, rows]);
  const [pageSize, setPageSize] = useState(20);
  const pagination = usePagination(visibleRequests, pageSize);

  useEffect(() => {
    let active = true;
    const reload = () => apiRequest<{ items: RequestItem[]; workTypes: RequestWorkType[]; engineers: RequestEngineer[]; workCategories: import("@/app/lib/work-catalog").WorkCategory[]; departmentTimezone: string }>("/api/requests")
      .then((data) => { if (active) { setRows(data.items); setWorkTypes(data.workTypes); setWorkCategories(data.workCategories); setEngineers(data.engineers); setDepartmentTimezone(data.departmentTimezone);
        if (!openedFromNotice.current) {
          const id = new URLSearchParams(window.location.search).get("open");
          if (id) { const request = data.items.find(item => item.id === id); if (request) setEditor({ mode: "edit", request }); else showNotice("Заявка недоступна в выбранном подразделении."); }
          openedFromNotice.current = true;
        } } })
      .catch((error: Error) => { if (active) showNotice(error.message); });
    void reload();
    const interval = window.setInterval(() => { if (!document.hidden) void reload(); }, 15000);
    window.addEventListener("focus", reload);
    return () => { active = false; window.clearInterval(interval); window.removeEventListener("focus", reload); };
  }, []);

  function showNotice(message: string) {
    setNotice(message);
    window.setTimeout(() => setNotice(""), 4000);
  }

  function openEditEditor(request: RequestItem) {
    setEditor({ mode: "edit", request });
  }

  function handleRowKeyDown(event: KeyboardEvent<HTMLTableRowElement>, request: RequestItem) {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openEditEditor(request);
    }
  }

  async function saveRequest(request: RequestItem) {
    try {
      const editing = editor?.mode === "edit";
      const payload = editing ? { ...request, id: editor.request.id } : request;
      const data = await apiRequest<{ item: RequestItem }>("/api/requests", { method: editing ? "PUT" : "POST", body: JSON.stringify(payload) });
      setRows((current) => editing ? current.map((item) => item.id === data.item.id ? data.item : item) : [data.item, ...current]);
      if (!editing) { setFilter("all"); pagination.resetPage(); }
      showNotice(editing ? `Заявка #${data.item.number ?? "Без номера"} обновлена.` : `Заявка #${data.item.number ?? "Без номера"} создана.`);
      setEditor(null);
      const refreshed = await apiRequest<{ items: RequestItem[] }>("/api/requests");
      setRows(refreshed.items);
    } catch (error) { showNotice(error instanceof Error ? error.message : "Не удалось сохранить заявку."); }
  }

  return (
    <DispatcherSectionShell user={user} active="requests" className="requests-shell">
      <main className="desktop-section requests-page">
        <header className="section-heading action-heading">
          <div><h1>Заявки</h1><p>Управление и мониторинг текущих задач</p></div>
          <button className="stitch-green-button" type="button" onClick={() => setEditor({ mode: "create" })}><MaterialIcon name="add" />Создать заявку</button>
        </header>

        <div className="request-filters" role="tablist" aria-label="Представление заявок">
          <button type="button" role="tab" aria-selected={view === "requests"} className={view === "requests" ? "active" : ""} onClick={() => setView("requests")}>Список заявок</button>
          <button type="button" role="tab" aria-selected={view === "problems"} className={view === "problems" ? "active" : ""} onClick={() => setView("problems")}>Журнал проблем ({problemEntries.length})</button>
        </div>
        {view === "requests" && <><div className="request-filters" role="tablist" aria-label="Статус заявок">
          {filters.map((item) => <button className={filter === item.id ? "active" : ""} type="button" role="tab" aria-selected={filter === item.id} onClick={() => { setFilter(item.id); pagination.resetPage(); }} key={item.id}>{item.label}</button>)}
        </div>

        <section className="stitch-table-card" aria-label="Список заявок">
          <div className="table-scroll">
            <table className="stitch-data-table requests-table">
              <thead><tr><th>Номер</th><th>Тип работ</th><th>Приоритет</th><th>Статус</th><th>Дата</th><th>Действия</th></tr></thead>
              <tbody>
                {pagination.pageItems.map((request) => (
                  <tr className="request-row" role="button" tabIndex={0} aria-label={`Редактировать заявку ${request.number ?? "Без номера"}`} onClick={() => openEditEditor(request)} onKeyDown={(event) => handleRowKeyDown(event, request)} key={request.id}>
                    <td><strong>#{request.number ?? "Без номера"}</strong></td>
                    <td>{request.work}</td>
                    <td><span className={`priority-chip ${request.priority}`}><i />{priorityLabels[request.priority]}</span></td>
                    <td><span className={`request-status ${request.status}`}>{statusLabels[request.status]}</span></td>
                    <td>{formatDateTime(request.dateTime)}{request.equipmentWarning && <small className="schedule-conflict-text">{request.equipmentWarning}</small>}{request.scheduleConflicts?.map(conflict => <small className="schedule-conflict-text" key={conflict.requestId}>{conflict.detail}</small>)}</td>
                    <td><span className="table-action request-edit-icon" aria-hidden="true"><MaterialIcon name="edit" /></span></td>
                  </tr>
                ))}
                {pagination.pageItems.length === 0 && <tr><td className="empty-row" colSpan={6}>Заявки с выбранным статусом не найдены</td></tr>}
              </tbody>
            </table>
          </div>
          <footer className="compact-table-footer"><Pagination page={pagination.page} pageCount={pagination.pageCount} pageSize={pageSize} totalItems={visibleRequests.length} itemLabel="заявок" onPageChange={pagination.setPage} onPageSizeChange={size => { setPageSize(size); pagination.resetPage(); }} /></footer>
        </section></>}
        {view === "problems" && <section className="stitch-table-card" aria-label="Журнал проблем диспетчера">
          <div className="table-scroll"><table className="stitch-data-table problem-journal-table">
            <thead><tr><th>Время регистрации · МСК</th><th>Заявка</th><th>Исполнитель</th><th>Проблема</th><th>Текущий статус</th></tr></thead>
            <tbody>{problemsPagination.pageItems.map(entry => <tr key={entry.id}>
              <td><time dateTime={entry.createdAt}>{problemTime(entry.createdAt)}</time></td>
              <td><button type="button" className="problem-request-link" onClick={() => openEditEditor(entry.request)}>#{entry.request.number ?? "Без номера"}</button></td>
              <td>{entry.workerName}</td><td><strong>{entry.reason}</strong><p>{entry.detail}</p></td>
              <td><span className={`request-status ${entry.request.status}`}>{statusLabels[entry.request.status]}</span></td>
            </tr>)}{!problemEntries.length && <tr><td className="empty-row" colSpan={5}>Сообщений о проблемах пока нет</td></tr>}</tbody>
          </table></div>
          <footer className="compact-table-footer"><Pagination page={problemsPagination.page} pageCount={problemsPagination.pageCount} pageSize={10} totalItems={problemEntries.length} itemLabel="сообщений" onPageChange={problemsPagination.setPage} /></footer>
        </section>}
      </main>

      {editor && <RequestEditor otherRequests={rows} workCategories={workCategories} departmentTimezone={departmentTimezone} initialRequest={editor.mode === "edit" ? { ...editor.request, problemLog: rows.find(row => row.id === editor.request.id)?.problemLog ?? editor.request.problemLog } : null} workTypes={workTypes} engineers={engineers} onClose={() => setEditor(null)} onSave={saveRequest} />}
      {notice && <div className="resource-notice" role="status">{notice}</div>}
    </DispatcherSectionShell>
  );
}

function formatDateTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  const months = ["Янв", "Фев", "Мар", "Апр", "Май", "Июн", "Июл", "Авг", "Сен", "Окт", "Ноя", "Дек"];
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${day} ${months[date.getMonth()]}, ${hours}:${minutes}`;
}
