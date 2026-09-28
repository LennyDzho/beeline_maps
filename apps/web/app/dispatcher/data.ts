export type Engineer = {
  id: string;
  initials: string;
  name: string;
  vehicle: string;
  schedule?: string;
  routeSummary?: string;
  removedAssignments?: Array<{ requestId: string; label: string; reason: string }>;
  load: number;
  accent: "gold" | "violet";
  visits: Array<{
    time: string;
    label: string;
    requestId?: string;
    travel?: string;
    kind?: "job" | "return";
    paused?: boolean;
    protectedStatus?: "en_route" | "in_progress";
    equipmentWarning?: string | null;
    scheduleConflicts?: Array<{ requestId: string; detail: string }>;
    change?: {
      kind: "assigned" | "reassigned" | "rescheduled";
      label: string;
      previousAgentName?: string;
      previousStartAt?: string;
    };
  }>;
};

export function isEngineerVisitOnDate(
  request: { assignee: string; dateTime: string },
  engineerName: string,
  serviceDate: string,
) {
  return request.assignee === engineerName && request.dateTime.slice(0, 10) === serviceDate;
}

export const engineers: Engineer[] = [
  {
    id: "EMP-402",
    initials: "АИ",
    name: "Алексей Иванов",
    vehicle: "Автомобиль • B732УО",
    load: 100,
    accent: "gold",
    visits: [
      { time: "09:00", label: "Заявка A-1428", requestId: "A-1428" },
      { time: "11:30", label: "Заявка A-1431", requestId: "A-1431" },
      { time: "14:00", label: "В пути", travel: "45 мин" },
    ],
  },
  {
    id: "EMP-415",
    initials: "МС",
    name: "Марина Соколова",
    vehicle: "Пеший курьер",
    load: 65,
    accent: "violet",
    visits: [
      { time: "10:15", label: "Заявка B-092", requestId: "B-092" },
      { time: "13:00", label: "Заявка B-104", requestId: "B-104" },
    ],
  },
];

export const stitchMapUrl =
  "https://lh3.googleusercontent.com/aida-public/AB6AXuAadU652Mx5ZIhVp0jN6oGoaakfwpjhZjogVmcFO7XtSAI9XyFiiNA-Mz67kgSB4Ls5G0rrKJnKJLlekz1dgDjFwpkBZZeTDEku7nKZoCRgGpLsSG-IEcafEGpekkmCMe-VSjiyjin1VEZjt9Y5ZBBkx0x-7Xd5JzOXyK3tZpPK8_L59KO1xLU0_UPwnbIrPfpQZu0ba2AnxqwUMbh6EonsoXtoiQB6vash0-CXVJClDIMVNNfqwmUq";
