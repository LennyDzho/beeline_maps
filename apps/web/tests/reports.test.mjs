import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import ts from "typescript";

const dataUrl = code => `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;
async function sourceModule(file, imports = {}) {
  let code = ts.transpileModule(await readFile(new URL(file, import.meta.url), "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
  for (const [alias, url] of Object.entries(imports)) code = code.replaceAll(`from "${alias}"`, `from "${url}"`);
  return dataUrl(code);
}
const serviceUrl = await sourceModule("../app/lib/server/reports.ts");
const { resolveReportPeriod, loadCompletionReport, ReportPeriodError } = await import(serviceUrl);
const { completionReportCsv, reportDate } = await import(await sourceModule("../app/reports/report-data.ts"));
const { buildWorkTypeChart } = await import(await sourceModule("../app/reports/work-type-chart.ts"));
const now = new Date("2026-09-08T12:00:00Z");
const custom = (from, to = from) => new URLSearchParams({ period: "custom", from, to });

test("work-type pie covers a complete circle for a single type", () => {
  const chart = buildWorkTypeChart([{ id: "T", name: "Установка оборудования", count: 1, confirmed: 0 }]);
  assert.equal(chart.total, 1);
  assert.equal(chart.slices[0].percentage, 100);
  assert.equal(chart.slices[0].start, 0);
  assert.equal(chart.slices[0].end, 100);
  assert.equal(chart.background, `conic-gradient(${chart.slices[0].color} 0% 100%)`);
});

test("pie slices use actual counts and unrounded contiguous boundaries, with matching legend colors", () => {
  const groups = [1, 1, 1].map((count, index) => ({ id: `T${index}`, name: `Тип ${index}`, count, confirmed: 0 }));
  const chart = buildWorkTypeChart(groups);
  assert.equal(chart.total, 3);
  assert.equal(chart.slices.length, 3);
  assert.ok(Math.abs(chart.slices[0].end - 100 / 3) < 1e-10);
  assert.equal(chart.slices[1].start, chart.slices[0].end);
  assert.equal(chart.slices[2].start, chart.slices[1].end);
  assert.equal(chart.slices[2].end, 100);
  assert.equal(new Set(chart.slices.map(slice => slice.color)).size, 3);
  for (const slice of chart.slices) assert.ok(chart.background.includes(`${slice.color} ${slice.start}% ${slice.end}%`));
  assert.deepEqual(groups.map(group => group.count), [1, 1, 1]);
});

test("pie handles empty data, zero counts and more types than the base palette", () => {
  assert.deepEqual(buildWorkTypeChart([]).slices, []);
  const empty = buildWorkTypeChart([{ id: "T", name: "Тип", count: 0, confirmed: 0 }]);
  assert.equal(empty.total, 0);
  assert.ok(!empty.background.includes("NaN"));
  const chart = buildWorkTypeChart(Array.from({ length: 12 }, (_, index) => ({ id: `T${index}`, name: `Тип ${index}`, count: index + 1, confirmed: 0 })));
  assert.equal(chart.slices.length, 12);
  assert.equal(chart.slices.at(-1).end, 100);
  assert.ok(chart.slices.every(slice => slice.color && Number.isFinite(slice.percentage)));
});

function fixture(t) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec(`CREATE TABLE organizations (id TEXT PRIMARY KEY, name TEXT, timezone TEXT);
    CREATE TABLE workers (id TEXT PRIMARY KEY, organization_id TEXT, full_name TEXT);
    CREATE TABLE work_types (id TEXT PRIMARY KEY, organization_id TEXT, name TEXT);
    CREATE TABLE work_type_versions (id TEXT PRIMARY KEY, work_type_id TEXT);
    CREATE TABLE work_reports (id TEXT PRIMARY KEY, work_order_id TEXT, performer_worker_id TEXT, submitted_at TEXT, revision INTEGER);
    CREATE TABLE work_orders (id TEXT PRIMARY KEY, organization_id TEXT, number TEXT, status TEXT,
      completed_at TEXT, scheduled_start TEXT, confirmed_at TEXT, updated_at TEXT, work_type_version_id TEXT, assignee_worker_id TEXT, address_snapshot TEXT);
    INSERT INTO organizations VALUES ('ORG', 'ТехноСервис', 'Europe/Moscow'), ('OTHER', 'Другое юрлицо', 'Asia/Yekaterinburg');
    INSERT INTO workers VALUES ('W1','ORG','Иван Иванов'), ('W2','ORG','Иван Иванов'), ('SECRET','OTHER','Чужой исполнитель');
    INSERT INTO work_types VALUES ('T','ORG','Ремонт'), ('SECRET','OTHER','Чужой тип работ');
    INSERT INTO work_type_versions VALUES ('V','T'), ('V2','T'), ('SECRET','SECRET');`);
  const database = {
    prepare(sql) {
      return { values: [], bind(...values) { this.values = values; return this; },
        async first() { return db.prepare(sql).get(...this.values) ?? null; },
        async all() { return { results: db.prepare(sql).all(...this.values) }; },
      };
    },
  };
  function order(id, completedAt, extra = {}) {
    const row = { id, organization_id: "ORG", number: id, status: "completed", completed_at: completedAt,
      scheduled_start: "2026-08-20T09:00", confirmed_at: null, updated_at: "2026-12-01T00:00:00Z",
      work_type_version_id: "V", assignee_worker_id: "W1", address_snapshot: "Москва", ...extra };
    db.prepare(`INSERT INTO work_orders (${Object.keys(row).join(",")}) VALUES (${Object.keys(row).map(() => "?").join(",")})`).run(...Object.values(row));
  }
  const report = (params = new URLSearchParams("period=current"), org = "ORG") => loadCompletionReport(database, org, params, now);
  return { db, database, order, report };
}

test("presets use the organization's calendar, including year and quarter boundaries", () => {
  for (const [preset, from, to] of [["current","2026-09-01","2026-09-30"], ["previous","2026-08-01","2026-08-31"], ["quarter","2026-07-01","2026-09-30"], ["year","2026-01-01","2026-12-31"]]) {
    const result = resolveReportPeriod(new URLSearchParams({ period: preset }), "Europe/Moscow", now);
    assert.equal(result.from, from); assert.equal(result.to, to);
  }
  const january = new Date("2025-12-31T22:00:00Z"); // Already January in Moscow.
  assert.equal(resolveReportPeriod(new URLSearchParams(), "Europe/Moscow", january).from, "2026-01-01");
  assert.equal(resolveReportPeriod(new URLSearchParams("period=previous"), "Europe/Moscow", january).from, "2025-12-01");
  assert.equal(resolveReportPeriod(new URLSearchParams("period=quarter"), "Europe/Moscow", new Date("2026-12-15T00:00Z")).to, "2026-12-31");
});

test("custom dates are inclusive local days, not UTC or browser dates", () => {
  const moscow = resolveReportPeriod(custom("2026-09-07"), "Europe/Moscow", now);
  assert.equal(moscow.startAt, "2026-09-06T21:00:00.000Z");
  assert.equal(moscow.endBefore, "2026-09-07T21:00:00.000Z");
  assert.equal(resolveReportPeriod(custom("2026-09-07"), "Asia/Novosibirsk", now).startAt, "2026-09-06T17:00:00.000Z");
  const dst = resolveReportPeriod(custom("2026-03-08"), "America/New_York", now);
  assert.equal(Date.parse(dst.endBefore) - Date.parse(dst.startAt), 23 * 3600_000);
});

test("invalid, reversed or excessively long ranges fail; leap days and 366 days work", () => {
  for (const params of [custom(""), custom("2026-02-30"), custom("2026-9-07"), custom("2026-09-08","2026-09-07"), custom("2024-01-01","2025-01-01"), new URLSearchParams("period=anything")]) {
    assert.throws(() => resolveReportPeriod(params, "Europe/Moscow", now), ReportPeriodError);
  }
  assert.equal(resolveReportPeriod(custom("2024-02-29"), "Europe/Moscow", now).to, "2024-02-29");
  assert.equal(resolveReportPeriod(custom("2024-01-01","2024-12-31"), "Europe/Moscow", now).from, "2024-01-01");
});

test("actual completion, not scheduled/updated/confirmation dates, determines inclusion", async t => {
  const f = fixture(t);
  f.order("IN", "2026-09-07T08:00:00Z");
  f.order("AUGUST", "2026-08-23T17:38:00Z", { scheduled_start: "2026-09-07T09:00", confirmed_at: "2026-09-08T00:00Z", status: "confirmed" });
  f.order("CONFIRMED", "2026-09-07T09:00:00Z", { status: "confirmed", confirmed_at: "2026-10-01T00:00Z" });
  for (const status of ["new","assigned","en_route","in_progress","paused","cancelled"]) f.order(status, "2026-09-07T12:00:00Z", { status });
  const result = await f.report();
  assert.deepEqual(result.items.map(item => item.id), ["CONFIRMED","IN"]);
  assert.deepEqual(result.summary, { completed: 2, confirmed: 1, workers: 1, missingCompletionDate: 0 });
  assert.equal((await f.report(new URLSearchParams("period=previous"))).summary.completed, 1);
});

test("local midnight is inclusive, following midnight exclusive, and offset timestamps work", async t => {
  const f = fixture(t);
  f.order("BEFORE", "2026-09-06T20:59:59.999Z");
  f.order("FIRST", "2026-09-06T21:00:00.000Z");
  f.order("OFFSET", "2026-09-07T06:30:00+05:00");
  f.order("SQLITE", "2026-09-07 14:30:00");
  f.order("LAST", "2026-09-07T20:59:59.999Z");
  f.order("AFTER", "2026-09-07T21:00:00.000Z");
  const result = await f.report(custom("2026-09-07"));
  assert.deepEqual(result.items.map(item => item.id), ["LAST","SQLITE","OFFSET","FIRST"]);
  assert.deepEqual(result.timeline, [{ date: "2026-09-07", count: 4 }]);
});

test("each order counts once across report and work-type revisions; performer takes precedence", async t => {
  const f = fixture(t);
  f.order("ONE", "2026-09-07T08:00Z");
  f.order("TWO", "2026-09-07T09:00Z", { work_type_version_id: "V2" });
  f.db.exec(`INSERT INTO work_reports VALUES ('R1','ONE','W1','2026-09-07T08:00Z',1),
    ('R2','ONE','W2','2026-09-07T08:30Z',2), ('DRAFT','ONE','W1',NULL,3)`);
  const result = await f.report();
  assert.equal(result.summary.completed, 2);
  assert.equal(result.summary.workers, 2, "same names are not merged");
  assert.equal(result.byWorkType.length, 1, "versions belong to the same work type");
  assert.equal(result.byWorkType[0].count, 2);
  assert.equal(result.items.find(item => item.id === "ONE").workerId, "W2");
  assert.equal(result.byWorker.length, 2);
});

test("division filtering applies to orders and workers; work types are shared", async t => {
  const f = fixture(t);
  f.order("LOCAL", "2026-09-07T08:00Z", { assignee_worker_id: "SECRET", work_type_version_id: "SECRET" });
  f.order("FOREIGN", "2026-09-07T08:00Z", { organization_id: "OTHER", assignee_worker_id: "SECRET", work_type_version_id: "SECRET" });
  const result = await f.report();
  assert.equal(result.summary.completed, 1);
  assert.equal(result.summary.workers, 0);
  assert.equal(result.items[0].worker, "Исполнитель не указан");
  assert.equal(result.items[0].workType, "Чужой тип работ");
  assert.ok(!result.items.some(item=>item.id==='FOREIGN'));
  const other = await f.report(new URLSearchParams("period=current"), "OTHER");
  assert.equal(other.items[0].id, "FOREIGN");
  assert.equal(other.period.timezone, "Asia/Yekaterinburg");
});

test("missing dates are flagged without substituting planned dates or leaking another organization", async t => {
  const f = fixture(t);
  f.order("NULL", null);
  f.order("BAD", "not-a-date");
  f.order("FOREIGN", null, { organization_id: "OTHER" });
  const result = await f.report();
  assert.deepEqual(result.summary, { completed: 0, confirmed: 0, workers: 0, missingCompletionDate: 2 });
  assert.equal(result.items.length, 0);
  assert.ok(result.timeline.every(item => item.count === 0));
});

test("empty periods have zeros, complete daily/monthly axes and no invented groups", async t => {
  const f = fixture(t);
  const day = await f.report(custom("2026-09-07"));
  assert.deepEqual(day.summary, { completed: 0, confirmed: 0, workers: 0, missingCompletionDate: 0 });
  assert.deepEqual(day.byWorker, []); assert.deepEqual(day.byWorkType, []);
  assert.deepEqual(day.timeline, [{ date: "2026-09-07", count: 0 }]);
  const year = await f.report(new URLSearchParams("period=year"));
  assert.equal(year.granularity, "month");
  assert.equal(year.timeline.length, 12);
  const crossing = await f.report(custom("2025-12-15","2026-03-01"));
  assert.deepEqual(crossing.timeline.map(item => item.date), ["2025-12","2026-01","2026-02","2026-03"]);
});

test("group totals and timeline equal details; CSV exports all pages with safe Russian text", async t => {
  const f = fixture(t);
  for (let i = 0; i < 45; i++) f.order(`ORDER-${i}`, "2026-09-07T10:00:00Z");
  f.order("=1+1", "2026-09-07T12:00:00Z", { address_snapshot: '  @SUM(1); "Москва"\nДом 2' });
  const result = await f.report();
  for (const groups of [result.timeline, result.byWorker, result.byWorkType]) assert.equal(groups.reduce((sum,item) => sum + item.count, 0), result.items.length);
  const csv = completionReportCsv(result);
  assert.ok(csv.startsWith("\uFEFF"));
  assert.ok(csv.includes('"\'=1+1"'));
  assert.ok(csv.includes('"\'  @SUM(1); ""Москва""\nДом 2"'));
  assert.ok(csv.includes("ORDER-44"));
  assert.ok(csv.includes("Ремонт"));
  assert.ok(csv.includes("07.09.2026, 15:00"));
  assert.equal(reportDate("2026-09-06T21:00:00Z","Europe/Moscow"), "07.09.2026, 00:00");
});

test("API requires reports.view, uses the authorized organization and rejects invalid periods", async t => {
  const f = fixture(t);
  f.order("LOCAL", "2026-09-07T10:00Z");
  f.order("FOREIGN", "2026-09-07T10:00Z", { organization_id: "OTHER" });
  const key = "__completionReportApiTest";
  globalThis[key] = { context: { database: f.database, user: { id: "USER" }, organizationId: "ORG" }, permission: null };
  t.after(() => { delete globalThis[key]; });
  const shared = dataUrl(`export async function requireApiContext(request,permission) { globalThis.${key}.permission=permission; return globalThis.${key}.context; }
    export function isApiError(value) { return value instanceof Response; }
    export const badRequest = message => Response.json({message},{status:400});
    export const serverError = () => Response.json({message:'error'},{status:500});`);
  const { GET } = await import(await sourceModule("../app/api/reports/route.ts", {
    "next/server": dataUrl("export const NextResponse = Response;"), "@/app/api/_shared": shared, "@/app/lib/server/reports": serviceUrl,
  }));
  const request = new Request("http://localhost/api/reports?period=custom&from=2026-09-01&to=2026-09-30&organizationId=OTHER");
  const response = await GET(request);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal(globalThis[key].permission, "reports.view");
  assert.deepEqual((await response.json()).items.map(item => item.id), ["LOCAL"]);
  assert.equal((await GET(new Request("http://localhost/api/reports?period=custom&from=wrong"))).status, 400);
  for (const status of [401,403]) {
    globalThis[key].context = Response.json({message:"denied"},{status});
    assert.equal((await GET(request)).status, status);
  }
});
