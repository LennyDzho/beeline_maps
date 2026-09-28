"use client";

import { useEffect, useState } from "react";
import { apiRequest } from "@/app/lib/api-client";
import type { EquipmentReport } from "@/app/lib/equipment-report";

export default function EquipmentReportDialog({ date, planId, workerId, departmentId, common, onClose, onOpenRequest }: {
  date: string; planId?: string; workerId?: string; departmentId?: string; common?: boolean; onClose: () => void; onOpenRequest: (id: string) => void;
}) {
  const [report, setReport] = useState<EquipmentReport | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    const params = new URLSearchParams({ date, ...(planId ? { planId } : {}), ...(workerId ? { workerId } : {}), ...(departmentId ? {departmentId} : {}) });
    apiRequest<{ report: EquipmentReport }>(`/api/planning/${common ? "group/" : ""}equipment?${params}`).then(result => { if (active) setReport(result.report); }).catch(reason => { if (active) setError(reason.message); });
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", close);
    return () => { active = false; window.removeEventListener("keydown", close); };
  }, [date, planId, workerId, departmentId, common, onClose]);
  return <div className="request-editor-backdrop"><section className="equipment-report-dialog" role="dialog" aria-modal="true" aria-labelledby="equipment-report-title">
    <header><div><h2 id="equipment-report-title">Требуемое оборудование</h2><p>{date}{planId ? " · выбранный план" : " · текущие назначения"}</p></div><button type="button" onClick={onClose} aria-label="Закрыть отчёт">×</button></header>
    {error ? <p role="alert">{error}</p> : !report ? <p role="status">Загрузка…</p> : <>
      <p>Заявок: {report.requestCount}. Количества по выездам приведены отдельно; повторное использование между выездами не предполагается.</p>
      {report.missingEquipmentOrderIds.length > 0 && <p>Оборудование не указано: {(report.missingEquipmentOrderNumbers ?? report.missingEquipmentOrderIds).join(", ")}.</p>}
      {report.groups.map(group => <section key={`${group.organizationId ?? ""}:${group.workerId ?? "unassigned"}`}><h3>{group.workerName}{group.departmentName ? ` · ${group.departmentName}` : ""}</h3>
        {group.workerId && <p>{group.issued ? group.issued.items===null ? "Бригада выехала; полученный комплект неизвестен." : `Бригада выехала. Полученный комплект: ${group.issued.items.map(item=>item.name).join(", ") || "пусто"}.` : "До выезда: комплект формируется по плану на весь день."}</p>}
        {group.items.length ? <table><thead><tr><th>Оборудование</th><th>Всего</th><th>Заявки и количество</th></tr></thead><tbody>{group.items.map(item => <tr key={item.equipmentId}><td>{item.name}{group.issued && !group.issued.items?.some(held=>held.equipmentId===item.equipmentId) && <small className="schedule-conflict-text">{group.issued.items===null?"Наличие не подтверждено":"Нет у бригады"}</small>}</td><td>{item.quantity === null ? "См. заявки" : `${item.quantity} ${item.unit}`}</td><td>{item.requests.map(request => <div key={request.id}><button type="button" onClick={() => onOpenRequest(request.id)}>{request.number ?? "Без номера"}</button> — {request.quantity ?? "не задано"}{request.quantity === null ? "" : ` ${item.unit}`}</div>)}</td></tr>)}</tbody></table> : <p>Оборудование не указано.</p>}</section>)}
    </>}
  </section></div>;
}
