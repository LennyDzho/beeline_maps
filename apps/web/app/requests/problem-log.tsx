export type ProblemEntry = {
  id: string;
  reason: string;
  detail: string;
  createdAt: string;
  workerName: string;
};

export function problemTime(value: string) {
  return new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit",
    timeZone: "Europe/Moscow",
  }).format(new Date(value));
}

export default function ProblemLog({ entries }: { entries: ProblemEntry[] }) {
  return <section className="request-problem-log" aria-label="Журнал проблем по заявке">
    <h3>Журнал проблем ({entries.length})</h3>
    <p className="field-hint">Время регистрации на сервере · МСК</p>
    <ol>{entries.map((entry) => <li key={entry.id}>
      <header><time dateTime={entry.createdAt}>{problemTime(entry.createdAt)}</time><span>{entry.workerName}</span></header>
      <strong>{entry.reason}</strong><p>{entry.detail}</p>
    </li>)}</ol>
  </section>;
}
