"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { AuthUser } from "@/auth/session";
import MaterialIcon from "@/app/components/material-icon";
import DispatcherSectionShell from "@/app/dispatcher/section-shell";
import { apiRequest } from "@/app/lib/api-client";
import { completionReportCsv, completionStatus, reportDate, type CompletionReport, type ReportPreset } from "./report-data";
import { buildWorkTypeChart } from "./work-type-chart";

const PAGE_SIZE = 20;
const count = (value: number) => value.toLocaleString("ru-RU");
const calendarDate = (value: string) => value.split("-").reverse().join(".");

export default function ReportsClient({ user }: { user: AuthUser }) {
  const [preset, setPreset] = useState<ReportPreset>("current");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [query, setQuery] = useState("period=current");
  const [refresh, setRefresh] = useState(0);
  const [report, setReport] = useState<CompletionReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [page, setPage] = useState(1);
  const reloadReport = useCallback(() => {
    setLoading(true);
    setError("");
    setRefresh((value) => value + 1);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    apiRequest<CompletionReport>(`/api/reports?${query}`, { signal: controller.signal })
      .then((data) => {
        if (controller.signal.aborted) return;
        setReport(data);
      })
      .catch((reason: unknown) => {
        if (controller.signal.aborted) return;
        setReport(null);
        setError(reason instanceof Error ? reason.message : "Не удалось загрузить отчёт.");
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [query, refresh]);

  useEffect(() => {
    // Pull accepted mobile changes when the dispatcher returns to this page.
    const refreshReport = () => { if (document.visibilityState === "visible") reloadReport(); };
    window.addEventListener("focus", refreshReport);
    const interval = window.setInterval(refreshReport, 60_000);
    return () => { window.removeEventListener("focus", refreshReport); window.clearInterval(interval); };
  }, [reloadReport]);

  function choosePeriod(value: ReportPreset) {
    setPreset(value);
    setNotice("");
    if (value === "custom") { setFrom(report?.period.from ?? ""); setTo(report?.period.to ?? ""); }
    else { setReport(null); setPage(1); setQuery(`period=${value}`); reloadReport(); }
  }

  function applyCustomPeriod(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setNotice("");
    setReport(null);
    setPage(1);
    setQuery(new URLSearchParams({ period: "custom", from, to }).toString());
    reloadReport();
  }

  function exportReport() {
    if (!report || loading) return;
    const blob = new Blob([completionReportCsv(report)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `completed-${report.organization.id}-${report.period.from}-${report.period.to}.csv`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    setNotice(`Выгружено заявок: ${count(report.items.length)}. Период: ${calendarDate(report.period.from)} — ${calendarDate(report.period.to)}.`);
  }

  const summary = report?.summary;
  const workTypeChart = buildWorkTypeChart(report?.byWorkType ?? []);
  const maxCount = Math.max(1, ...(report?.timeline.map((item) => item.count) ?? []));
  const totalPages = Math.max(1, Math.ceil((report?.items.length ?? 0) / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const dirtyPeriod = preset === "custom" && (report?.period.preset !== "custom" || from !== report.period.from || to !== report.period.to);

  return (
    <DispatcherSectionShell user={user} active="reports" className="reports-shell">
      <main className="desktop-section reports-page">
        <header className="section-heading reports-heading">
          <div><h1>Аналитика и Отчёты</h1><p>Выполненные заявки по фактической дате завершения.</p></div>
          <div className="reports-actions">
            <button className="stitch-outline-button" type="button" disabled={loading} onClick={reloadReport}><MaterialIcon name="refresh" />Обновить</button>
            <button className="stitch-primary-button" type="button" disabled={!report || loading || dirtyPeriod || !report.items.length} onClick={exportReport}><MaterialIcon name="download" />Экспорт CSV</button>
          </div>
        </header>

        <form className="report-filters" onSubmit={applyCustomPeriod}>
          <label>Период отчёта<select value={preset} onChange={(event) => choosePeriod(event.target.value as ReportPreset)}>
            <option value="current">Текущий месяц</option><option value="previous">Предыдущий месяц</option><option value="quarter">Текущий квартал</option><option value="year">Текущий год</option><option value="custom">Произвольный период</option>
          </select></label>
          {preset === "custom" && <>
            <label>С<input type="date" value={from} required min="1900-01-01" max={to || "2199-12-31"} onChange={(event) => setFrom(event.target.value)} /></label>
            <label>По (включительно)<input type="date" value={to} required min={from || "1900-01-01"} max="2199-12-31" onChange={(event) => setTo(event.target.value)} /></label>
            <button className="stitch-primary-button" type="submit" disabled={loading}>Применить</button>
            <small>Не более 366 дней{dirtyPeriod ? " · Нажмите «Применить»" : ""}</small>
          </>}
        </form>

        {error && <div className="report-message report-error" role="alert">{error} <button type="button" onClick={reloadReport}>Повторить</button></div>}
        {notice && <div className="report-message" role="status">{notice}</div>}
        {loading && <p className="report-message" role="status">Обновляем данные отчёта…</p>}

        {report && <div className="report-results" aria-busy={loading}>
          <p className="report-period-caption">
            <strong>{report.organization.name}</strong> · {calendarDate(report.period.from)} — {calendarDate(report.period.to)} · {report.period.timezone}
            <span>Обновлено: {reportDate(report.generatedAt, report.period.timezone)}. Выполненные включают подтверждённые; каждая заявка учитывается один раз.</span>
          </p>
          {summary!.missingCompletionDate > 0 && <p className="report-message report-warning" role="status">
            У завершённых заявок этого юрлица не заполнена корректная дата завершения: {count(summary!.missingCompletionDate)}. Они исключены из отчёта, поскольку их нельзя отнести к периоду. Плановая дата не подставляется.
          </p>}

          <section className="report-metrics" aria-label="Основные показатели за выбранный период">
            <article><div><MaterialIcon name="task_alt" /><small>Выполненные заявки</small></div><strong>{count(summary!.completed)}</strong><p>Завершены за выбранный период</p></article>
            <article><div><MaterialIcon name="verified" /><small>Из них подтверждено</small></div><strong>{count(summary!.confirmed)}</strong><p>Подтверждены диспетчером на данный момент</p></article>
            <article><div><MaterialIcon name="engineering" /><small>Исполнители</small></div><strong>{count(summary!.workers)}</strong><p>Имеют выполненные заявки за период</p></article>
          </section>

          {!report.items.length ? <section className="report-empty" role="status"><MaterialIcon name="event_available" /><h2>Нет выполненных заявок за выбранный период</h2><p>Выберите другой период. Назначенные, приостановленные и отменённые заявки сюда не входят.</p></section> : <>
            <section className="reports-grid">
              <article className="report-card report-bar-card">
                <header><div><h2>Выполненные заявки {report.granularity === "day" ? "по дням" : "по месяцам"}</h2><p>Фактическое завершение в часовом поясе организации</p></div></header>
                {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- Keyboard access to the horizontally scrollable chart. */}
                <div className="completion-chart" role="region" aria-label="Динамика выполненных заявок" tabIndex={0}>
                  <div className="completion-bars" style={{ minWidth: `${Math.max(280, report.timeline.length * 38)}px` }}>
                    {report.timeline.map((item) => <div className="completion-column" key={item.date}>
                      <div className="completion-track"><div className="completion-bar" style={{ height: `${item.count / maxCount * 100}%` }} title={`${item.date}: ${item.count}`}><span>{count(item.count)}</span></div></div>
                      <small>{report.granularity === "day" ? `${item.date.slice(8)}.${item.date.slice(5, 7)}` : `${item.date.slice(5)}.${item.date.slice(0, 4)}`}</small>
                    </div>)}
                  </div>
                </div>
              </article>

              <article className="report-card report-types-card">
                <header><div><h2>По типам работ</h2><p>Доля среди выполненных заявок за период</p></div></header>
                <div className="completion-types-layout">
                  <div className="completion-donut" style={{ background: workTypeChart.background }} role="img"
                    aria-label={`Круговая диаграмма по типам работ. Всего выполнено заявок: ${count(workTypeChart.total)}. Подробные значения в легенде рядом.`}>
                    <span aria-hidden="true"><strong>{count(workTypeChart.total)}</strong><small>выполнено</small></span>
                  </div>
                  <ul className="completion-types" aria-label="Легенда: типы работ, количество и доля заявок">{workTypeChart.slices.map((item) => <li key={item.id}>
                    <i className="completion-type-dot" style={{ background: item.color }} aria-hidden="true" />
                    <span>{item.name}</span><strong>{count(item.count)} <small>· {item.percentage.toLocaleString("ru-RU", { maximumFractionDigits: 1 })}%</small></strong>
                  </li>)}</ul>
                </div>
              </article>

              <article className="report-card report-workers-card">
                <header><div><h2>По исполнителям</h2><p>Исполнитель из отчёта о выполнении, при отсутствии отчёта — назначенный в заявке</p></div></header>
                <div className="report-table-scroll"><table className="completion-table"><caption className="sr-only">Выполненные заявки по исполнителям</caption><thead><tr><th scope="col">Исполнитель</th><th scope="col">Выполнено</th><th scope="col">Из них подтверждено</th></tr></thead>
                  <tbody>{report.byWorker.map((item) => <tr key={item.id}><td>{item.name}</td><td>{count(item.count)}</td><td>{count(item.confirmed)}</td></tr>)}</tbody>
                </table></div>
              </article>
            </section>

            <section className="report-card report-details">
              <header><div><h2>Выполненные заявки за период</h2><p>Всего: {count(report.items.length)}. В CSV выгружается весь выбранный период, а не только текущая страница.</p></div></header>
              <div className="report-table-scroll"><table className="completion-table"><caption className="sr-only">Заявки, завершённые за выбранный период</caption>
                <thead><tr><th scope="col">Заявка</th><th scope="col">Тип работ / адрес</th><th scope="col">Исполнитель</th><th scope="col">Завершена</th><th scope="col">Статус</th></tr></thead>
                <tbody>{report.items.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE).map((item) => <tr key={item.id}>
                  <td>{item.number}</td><td>{item.workType}<small>{item.address}</small></td><td>{item.worker}</td>
                  <td className="completion-date"><time dateTime={item.completedAt}>{reportDate(item.completedAt, report.period.timezone)}</time></td>
                  <td><span className={`completion-status ${item.status}`}>{completionStatus(item.status)}</span></td>
                </tr>)}</tbody>
              </table></div>
              {totalPages > 1 && <nav className="report-pagination" aria-label="Страницы выполненных заявок">
                <button type="button" disabled={currentPage <= 1} onClick={() => setPage(currentPage - 1)}>Назад</button><span>{currentPage} / {totalPages}</span><button type="button" disabled={currentPage >= totalPages} onClick={() => setPage(currentPage + 1)}>Далее</button>
              </nav>}
            </section>
          </>}
        </div>}
      </main>
    </DispatcherSectionShell>
  );
}
