import type { PlanningResult } from "./planning-types";

export default function ClientApprovals({ plan, selected, onChange }: { plan: PlanningResult; selected: string[]; onChange: (ids: string[]) => void }) {
  if (!plan.clientApprovals?.length) return null;
  return <section className="client-approval-notice" aria-label="Сообщение клиентам о переносах">
    <h3>{plan.status === "published" ? "Переносы согласованы при публикации" : "Сообщите клиентам об изменениях"}</h3>
    {plan.status === "draft" && <p>До публикации действуют прежние назначения. Отметьте каждый визит после сообщения клиенту.</p>}
    <ul>{plan.clientApprovals.map(change => <li key={change.id}>
      <strong>{change.label}</strong>
      <p>Было: {change.before.workerName || "Не назначен"} · {change.before.start.replace("T", " ")} ({change.before.timezone}), позиция {change.before.sequence ?? "—"}.<br />
        Стало: {change.after.workerId ? `${change.after.workerName} · ${change.after.start.replace("T", " ")} (${change.after.timezone}), позиция ${change.after.sequence ?? "—"}` : "Не назначена"}.</p>
      <p>{change.reason}</p>
      {plan.status === "draft" && <label className="client-confirmation-check"><input type="checkbox" checked={selected.includes(change.id)}
        onChange={event => onChange(event.target.checked ? [...selected.filter(id => id !== change.id), change.id] : selected.filter(id => id !== change.id))} /><span>Я сообщил клиенту об изменении {change.label}</span></label>}
    </li>)}</ul>
  </section>;
}
