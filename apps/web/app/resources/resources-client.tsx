"use client";

import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import type { AuthUser } from "@/auth/session";
import MaterialIcon from "@/app/components/material-icon";
import Pagination from "@/app/components/pagination";
import DispatcherSectionShell from "@/app/dispatcher/section-shell";
import { usePagination } from "@/app/hooks/use-pagination";
import { apiRequest } from "@/app/lib/api-client";
import { statusIcons, statusLabels, type Vehicle, type VehicleStatus } from "./resource-data";
import ResourceEditor from "./resource-editor";

type StatusFilter = "all" | VehicleStatus;
type TypeFilter = "all" | "Фургон" | "Легковой";
type EditorState = { mode: "create" } | { mode: "edit"; resource: Vehicle };

export default function ResourcesClient({ user }: { user: AuthUser }) {
  const [rows, setRows] = useState<Vehicle[]>([]);
  const [engineers, setEngineers] = useState<Array<{ id: string; name: string }>>([]);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [type, setType] = useState<TypeFilter>("all");
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [notice, setNotice] = useState("");

  const filteredVehicles = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase("ru");
    return rows.filter((vehicle) => {
      const matchesQuery = !normalized || [vehicle.name, vehicle.plate, vehicle.assignment ?? ""]
        .some((value) => value.toLocaleLowerCase("ru").includes(normalized));
      const matchesStatus = status === "all" || vehicle.status === status;
      const matchesType = type === "all" || vehicle.type === type;
      return matchesQuery && matchesStatus && matchesType;
    });
  }, [query, rows, status, type]);
  const pagination = usePagination(filteredVehicles, 3);

  useEffect(() => {
    let active = true;
    apiRequest<{ items: Vehicle[]; engineers: Array<{ id: string; name: string }> }>("/api/resources")
      .then((data) => { if (active) { setRows(data.items); setEngineers(data.engineers); } })
      .catch((error: Error) => { if (active) setNotice(error.message); });
    return () => { active = false; };
  }, []);

  function requestStitchForm(message: string) {
    setNotice(message);
    window.setTimeout(() => setNotice(""), 4000);
  }

  function openEditEditor(resource: Vehicle) {
    setEditor({ mode: "edit", resource });
  }

  function handleRowKeyDown(event: KeyboardEvent<HTMLTableRowElement>, resource: Vehicle) {
    if ((event.key === "Enter" || event.key === " ") && event.target === event.currentTarget) {
      event.preventDefault();
      openEditEditor(resource);
    }
  }

  async function saveResource(resource: Vehicle) {
    try {
      const editing = editor?.mode === "edit";
      const payload = editing ? { ...resource, id: editor.resource.id } : resource;
      const data = await apiRequest<{ item: Vehicle }>("/api/resources", { method: editing ? "PUT" : "POST", body: JSON.stringify(payload) });
      setRows((current) => editing ? current.map((item) => item.id === data.item.id ? data.item : item) : [data.item, ...current]);
      if (!editing) { setQuery(""); setStatus("all"); setType("all"); pagination.resetPage(); }
      requestStitchForm(editing ? `Ресурс #${data.item.id} обновлён.` : `Ресурс #${data.item.id} добавлен.`);
      setEditor(null);
    } catch (error) { requestStitchForm(error instanceof Error ? error.message : "Не удалось сохранить ресурс."); }
  }

  return (
    <DispatcherSectionShell user={user} active="resources" className="resources-shell">
        <main className="resources-page">
          <div className="resources-container">
            <header className="resources-heading">
              <h1>Ресурсы</h1>
              <p>Управление транспортом и оборудованием организации</p>
            </header>

            <div className="resource-tabs" role="tablist" aria-label="Тип ресурса">
              <button className="active" type="button" role="tab" aria-selected="true">Транспорт</button>
              <button type="button" role="tab" aria-selected="false" onClick={() => requestStitchForm("Для вкладки «Оборудование» нужна отдельная экранная форма Stitch.")}>Оборудование</button>
            </div>

            <section className="resource-metrics" aria-label="Сводка по транспорту">
              <article><div><small>Всего ТС</small><MaterialIcon name="local_shipping" /></div><strong>{rows.length}</strong></article>
              <article className="primary"><div><small>В эксплуатации</small><MaterialIcon name="route" /></div><strong>{rows.filter((item) => item.status === "working").length}</strong></article>
              <article className="gold"><div><small>На обслуживании</small><MaterialIcon name="build" /></div><strong>{rows.filter((item) => item.status === "repair").length}</strong></article>
              <article className="neutral"><div><small>Свободно</small><MaterialIcon name="check_circle" /></div><strong>{rows.filter((item) => item.status === "available").length}</strong></article>
            </section>

            <section className="resource-toolbar" aria-label="Фильтры транспорта">
              <div className="resource-filters">
                <label className="vehicle-search">
                  <MaterialIcon name="search" />
                  <span className="sr-only">Поиск по транспортным средствам</span>
                  <input type="search" placeholder="Поиск по ТС..." value={query} onChange={(event) => { setQuery(event.target.value); pagination.resetPage(); }} />
                </label>
                <label><span className="sr-only">Статус</span><select value={status} onChange={(event) => { setStatus(event.target.value as StatusFilter); pagination.resetPage(); }}><option value="all">Статус: Все</option><option value="working">В работе</option><option value="repair">В ремонте</option><option value="available">Свободен</option></select></label>
                <label><span className="sr-only">Тип</span><select value={type} onChange={(event) => { setType(event.target.value as TypeFilter); pagination.resetPage(); }}><option value="all">Тип: Все</option><option value="Легковой">Легковой</option><option value="Фургон">Фургон</option></select></label>
                <label><span className="sr-only">Участок</span><select defaultValue="all"><option value="all">Участок: Все</option></select></label>
              </div>
              <button className="add-resource-button" type="button" onClick={() => setEditor({ mode: "create" })}><MaterialIcon name="add" />Добавить ресурс</button>
            </section>

            <section className="resource-table-card" aria-label="Транспорт организации">
              <div className="resource-table-scroll">
                <table className="resource-table">
                  <thead><tr><th>Транспорт</th><th>Тип</th><th>Госномер</th><th>Статус</th><th>Текущее назначение</th><th>Тех. состояние</th><th><span className="sr-only">Действия</span></th></tr></thead>
                  <tbody>
                    {pagination.pageItems.map((vehicle) => (
                      <tr className="resource-row" role="button" tabIndex={0} aria-label={`Редактировать ресурс ${vehicle.name}`} onClick={() => openEditEditor(vehicle)} onKeyDown={(event) => handleRowKeyDown(event, vehicle)} key={vehicle.id}>
                        <td><div className="vehicle-name"><span><MaterialIcon name={vehicle.type === "Фургон" ? "local_shipping" : "directions_car"} /></span><div><strong>{vehicle.name}</strong><small>#{vehicle.plate}</small></div></div></td>
                        <td className="muted-cell">{vehicle.type}</td>
                        <td><span className="plate-number">{vehicle.plate}<b>{vehicle.region}</b></span></td>
                        <td><span className={`vehicle-status ${vehicle.status}`}><MaterialIcon name={statusIcons[vehicle.status]} />{statusLabels[vehicle.status]}</span></td>
                        <td className={vehicle.assignment ? "" : "muted-cell italic"}>
                          <span className="resource-assignment"><span>{vehicle.assignment ?? "Не назначен"}</span>{Boolean(vehicle.plannedJobs) && <small><MaterialIcon name="event_note" />{vehicle.plannedJobs} {pluralizeJobs(vehicle.plannedJobs ?? 0)} в опубликованном плане{vehicle.nextPlannedAt ? ` · с ${formatDateTime(vehicle.nextPlannedAt)}` : ""}</small>}</span>
                        </td>
                        <td>{vehicle.condition === "Исправен" ? <span className="vehicle-condition good"><MaterialIcon name="check_circle" />Исправен</span> : <span className="vehicle-condition service"><span><MaterialIcon name="warning" />ТО до {formatServiceDate(vehicle.serviceDate)}</span><i><b /></i></span>}</td>
                        <td><button className="row-action" type="button" aria-label={`Редактировать: ${vehicle.name}`} onClick={(event) => { event.stopPropagation(); openEditEditor(vehicle); }}><MaterialIcon name="more_vert" /></button></td>
                      </tr>
                    ))}
                    {pagination.pageItems.length === 0 && <tr><td className="resource-empty" colSpan={7}>По заданным фильтрам транспорт не найден</td></tr>}
                  </tbody>
                </table>
              </div>
              <footer className="resource-table-footer"><Pagination page={pagination.page} pageCount={pagination.pageCount} pageSize={3} totalItems={filteredVehicles.length} itemLabel="ресурсов" onPageChange={pagination.setPage} /></footer>
            </section>
          </div>
        </main>
      {editor && <ResourceEditor initialResource={editor.mode === "edit" ? editor.resource : null} engineers={engineers} onClose={() => setEditor(null)} onSave={saveResource} />}
      {notice && <div className="resource-notice" role="status">{notice}</div>}
    </DispatcherSectionShell>
  );
}

function formatServiceDate(value: string | undefined) {
  if (!value) return "—";
  const isoMatch = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  return isoMatch ? `${isoMatch[3]}.${isoMatch[2]}.${isoMatch[1]}` : value;
}

function formatDateTime(value: string) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Moscow" }).format(parsed);
}

function pluralizeJobs(value: number) {
  const lastTwo = value % 100;
  const last = value % 10;
  if (last === 1 && lastTwo !== 11) return "заявка";
  if (last >= 2 && last <= 4 && (lastTwo < 12 || lastTwo > 14)) return "заявки";
  return "заявок";
}
