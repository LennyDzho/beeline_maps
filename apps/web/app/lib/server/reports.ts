import type { CompletedOrder, CompletionReport, ReportGroup, ReportPeriod, ReportPreset } from "../../reports/report-data";

const DAY_MS = 86_400_000;

export class ReportPeriodError extends Error {}

function dateFormatter(timezone: string) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" });
}

function localDate(date: Date, formatter: Intl.DateTimeFormat): string {
  const parts = formatter.formatToParts(date);
  return ["year", "month", "day"].map((type) => parts.find((part) => part.type === type)!.value).join("-");
}

function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

function validDate(date: string): boolean {
  if (!/^(19|20|21)\d{2}-\d{2}-\d{2}$/u.test(date)) return false;
  const time = Date.parse(`${date}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === date;
}

// Form dates are calendar dates in the organization's timezone, not the browser's.
// Solve local midnight in UTC; recalculating the offset also handles DST boundaries.
function startOfDay(date: string, timezone: string): string {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  });
  const target = Date.parse(`${date}T00:00:00Z`);
  let instant = target;
  for (let attempt = 0; attempt < 4; attempt++) {
    const parts = formatter.formatToParts(new Date(instant));
    const value = (type: string) => Number(parts.find((part) => part.type === type)!.value);
    const displayed = Date.UTC(value("year"), value("month") - 1, value("day"), value("hour"), value("minute"), value("second"));
    const correction = target - displayed;
    if (!correction) return new Date(instant).toISOString();
    instant += correction;
  }
  throw new ReportPeriodError("Не удалось определить границы периода в часовом поясе организации.");
}

export function resolveReportPeriod(params: URLSearchParams, timezone: string, now = new Date()): ReportPeriod & { startAt: string; endBefore: string } {
  const preset = params.get("period") ?? "current";
  if (!["current", "previous", "quarter", "year", "custom"].includes(preset)) throw new ReportPeriodError("Неизвестный период отчёта.");
  const today = localDate(now, dateFormatter(timezone));
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7)) - 1;
  const monthStart = (y: number, m: number) => new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
  let from = monthStart(year, month);
  let to = addDays(monthStart(year, month + 1), -1);
  if (preset === "previous") { from = monthStart(year, month - 1); to = addDays(monthStart(year, month), -1); }
  if (preset === "quarter") { from = monthStart(year, Math.floor(month / 3) * 3); to = addDays(monthStart(year, Math.floor(month / 3) * 3 + 3), -1); }
  if (preset === "year") { from = monthStart(year, 0); to = addDays(monthStart(year + 1, 0), -1); }
  if (preset === "custom") { from = params.get("from") ?? ""; to = params.get("to") ?? ""; }
  if (!validDate(from) || !validDate(to)) throw new ReportPeriodError("Укажите корректные даты начала и окончания периода.");
  if (from > to) throw new ReportPeriodError("Дата начала должна быть не позже даты окончания.");
  if ((Date.parse(to) - Date.parse(from)) / DAY_MS >= 366) throw new ReportPeriodError("Выберите период не более 366 дней.");
  return { preset: preset as ReportPreset, from, to, timezone, startAt: startOfDay(from, timezone), endBefore: startOfDay(addDays(to, 1), timezone) };
}

type CompletionRow = {
  id: string; number: string; status: CompletedOrder["status"]; completed_at: string | null;
  completion_ms: number | null; work_type_id: string | null; work_type: string | null;
  worker_id: string | null; worker_name: string | null; address_snapshot: string;
};

export async function loadCompletionReport(database: D1Database, organizationId: string, params: URLSearchParams, now = new Date()): Promise<CompletionReport> {
  const organization = await database.prepare("SELECT id, name, timezone FROM organizations WHERE id = ?").bind(organizationId)
    .first<{ id: string; name: string; timezone: string }>();
  if (!organization) throw new Error("Организация не найдена.");
  const { startAt, endBefore, ...period } = resolveReportPeriod(params, organization.timezone, now);
  // One row per order: multiple report revisions must not multiply counts.
  // Only real completion timestamps determine the period. Confirmation, planning,
  // edits and draft route calculations are not completion events.
  const result = await database.prepare(`SELECT o.id, o.number, o.status, o.completed_at,
      ROUND((julianday(o.completed_at) - 2440587.5) * 86400000) AS completion_ms,
      t.id AS work_type_id, t.name AS work_type, w.id AS worker_id, w.full_name AS worker_name, o.address_snapshot
    FROM work_orders o
    LEFT JOIN work_type_versions v ON v.id = o.work_type_version_id
    LEFT JOIN work_types t ON t.id = v.work_type_id
    LEFT JOIN work_reports r ON r.id = (SELECT r2.id FROM work_reports r2
      WHERE r2.work_order_id = o.id AND r2.submitted_at IS NOT NULL ORDER BY r2.revision DESC LIMIT 1)
    LEFT JOIN workers w ON w.id = COALESCE(r.performer_worker_id, o.assignee_worker_id) AND w.organization_id = o.organization_id
    WHERE o.organization_id = ? AND o.status IN ('completed', 'confirmed')
      AND ((julianday(o.completed_at) >= julianday(?) AND julianday(o.completed_at) < julianday(?))
        OR julianday(o.completed_at) IS NULL)
    ORDER BY julianday(o.completed_at) DESC, o.number, o.id`).bind(organizationId, startAt, endBefore).all<CompletionRow>();

  const formatter = dateFormatter(period.timezone);
  const granularity = (Date.parse(period.to) - Date.parse(period.from)) / DAY_MS < 62 ? "day" : "month";
  const buckets = new Map<string, number>();
  for (let date = period.from; date <= period.to; date = addDays(date, 1)) buckets.set(granularity === "day" ? date : date.slice(0, 7), 0);
  const byWorkType = new Map<string, ReportGroup>();
  const byWorker = new Map<string, ReportGroup>();
  const workerIds = new Set<string>();
  const items: CompletedOrder[] = [];
  let missingCompletionDate = 0;
  let confirmed = 0;
  for (const row of result.results) {
    if (row.completion_ms === null || !Number.isFinite(row.completion_ms)) { missingCompletionDate++; continue; }
    const item: CompletedOrder = {
      id: row.id, number: row.number, workTypeId: row.work_type_id, workType: row.work_type ?? "Тип работ не указан",
      workerId: row.worker_id, worker: row.worker_name ?? "Исполнитель не указан", address: row.address_snapshot,
      status: row.status, completedAt: new Date(row.completion_ms).toISOString(),
    };
    items.push(item);
    if (item.status === "confirmed") confirmed++;
    if (item.workerId) workerIds.add(item.workerId);
    const date = localDate(new Date(row.completion_ms), formatter);
    const bucket = granularity === "day" ? date : date.slice(0, 7);
    buckets.set(bucket, (buckets.get(bucket) ?? 0) + 1);
    for (const [groups, id, name] of [[byWorkType, item.workTypeId, item.workType], [byWorker, item.workerId, item.worker]] as const) {
      const key = id ?? "__not_specified__";
      const group = groups.get(key) ?? { id: key, name, count: 0, confirmed: 0 };
      group.count++;
      if (item.status === "confirmed") group.confirmed++;
      groups.set(key, group);
    }
  }
  const sorted = (groups: Map<string, ReportGroup>) => [...groups.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, "ru"));
  return {
    organization: { id: organization.id, name: organization.name }, period, generatedAt: now.toISOString(),
    summary: { completed: items.length, confirmed, workers: workerIds.size, missingCompletionDate }, granularity,
    timeline: [...buckets].map(([date, count]) => ({ date, count })), byWorkType: sorted(byWorkType), byWorker: sorted(byWorker), items,
  };
}
