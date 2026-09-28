export type ReportPreset = "current" | "previous" | "quarter" | "year" | "custom";
export type ReportPeriod = {
  preset: ReportPreset;
  from: string;
  to: string;
  timezone: string;
};
export type CompletedOrder = {
  id: string;
  number: string;
  workTypeId: string | null;
  workType: string;
  workerId: string | null;
  worker: string;
  address: string;
  status: "completed" | "confirmed";
  completedAt: string;
};
export type ReportGroup = { id: string; name: string; count: number; confirmed: number };
export type CompletionReport = {
  organization: { id: string; name: string };
  period: ReportPeriod;
  generatedAt: string;
  summary: { completed: number; confirmed: number; workers: number; missingCompletionDate: number };
  granularity: "day" | "month";
  timeline: { date: string; count: number }[];
  byWorkType: ReportGroup[];
  byWorker: ReportGroup[];
  items: CompletedOrder[];
};

export function reportDate(value: string, timezone: string): string {
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: timezone, day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit",
  }).format(new Date(value));
}

export function completionStatus(status: CompletedOrder["status"]): string {
  return status === "confirmed" ? "Подтверждена" : "Выполнена";
}

// Quote every cell and neutralize formulas when the export is opened in Excel.
function csvCell(value: string): string {
  const safe = /^[\s\uFEFF]*[=+@-]/u.test(value) || /^[\t\r\n]/u.test(value) ? `'${value}` : value;
  return `"${safe.replaceAll('"', '""')}"`;
}

export function completionReportCsv(report: CompletionReport): string {
  const rows = [
    ["Организация", "Период с", "Период по", "Номер заявки", "Тип работ", "Исполнитель", "Адрес", "Завершена", "Часовой пояс", "Статус"],
    ...report.items.map((item) => [report.organization.name, report.period.from, report.period.to,
      item.number, item.workType, item.worker, item.address, reportDate(item.completedAt, report.period.timezone),
      report.period.timezone, completionStatus(item.status)]),
  ];
  return `\uFEFF${rows.map((row) => row.map(csvCell).join(";")).join("\r\n")}`;
}
