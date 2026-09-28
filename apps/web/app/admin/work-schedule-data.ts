export type WorkScheduleDay = {
  weekday: number;
  enabled: boolean;
  startTime: string;
  endTime: string;
  breakStart: string;
  breakEnd: string;
};

export type WorkScheduleRecord = {
  id: string;
  name: string;
  active: boolean;
  days: WorkScheduleDay[];
};

export const weekdayLabels = ["Понедельник", "Вторник", "Среда", "Четверг", "Пятница", "Суббота", "Воскресенье"] as const;
const weekdayShortLabels = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"] as const;

export function createDefaultScheduleDays(): WorkScheduleDay[] {
  return weekdayLabels.map((_, index) => ({
    weekday: index + 1,
    enabled: index < 5,
    startTime: "08:00",
    endTime: "17:00",
    breakStart: index < 5 ? "12:00" : "",
    breakEnd: index < 5 ? "13:00" : "",
  }));
}

export function scheduleSummary(schedule: WorkScheduleRecord): string {
  const enabled = schedule.days.filter((day) => day.enabled);
  if (!enabled.length) return "Нет рабочих дней";
  const weekdays = enabled.map((day) => weekdayShortLabels[day.weekday - 1]).join(", ");
  const hours = new Set(enabled.map((day) => `${day.startTime}–${day.endTime}`));
  const breaks = new Set(enabled.map((day) => day.breakStart && day.breakEnd ? `${day.breakStart}–${day.breakEnd}` : "без перерыва"));
  const breakValue = breaks.size === 1 ? [...breaks][0] : "разные перерывы";
  const breakSummary = breakValue === "без перерыва" || breakValue === "разные перерывы" ? breakValue : `перерыв ${breakValue}`;
  return `${weekdays} · ${hours.size === 1 ? [...hours][0] : "разные часы"} · ${breakSummary}`;
}
