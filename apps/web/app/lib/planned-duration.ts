export const DEFAULT_PLANNED_DURATION_MINUTES = 60;
export const MIN_PLANNED_DURATION_MINUTES = 15;
export const MAX_PLANNED_DURATION_MINUTES = 480;

export function isPlannedDurationMinutes(value: unknown): value is number {
  return Number.isInteger(value)
    && Number(value) >= MIN_PLANNED_DURATION_MINUTES
    && Number(value) <= MAX_PLANNED_DURATION_MINUTES;
}

/** Adds minutes without shifting a timezone-less datetime-local value. */
export function addMinutesToTimestamp(value: string, minutes: number): string | null {
  if (!isPlannedDurationMinutes(minutes)) return null;
  const local = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/u.exec(value);
  if (local) {
    const [, year, month, day, hour, minute, second = "00"] = local;
    const timestamp = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second));
    const parsed = new Date(timestamp);
    if (parsed.getUTCFullYear() !== Number(year) || parsed.getUTCMonth() !== Number(month) - 1 || parsed.getUTCDate() !== Number(day)
      || parsed.getUTCHours() !== Number(hour) || parsed.getUTCMinutes() !== Number(minute) || parsed.getUTCSeconds() !== Number(second)) return null;
    const result = new Date(timestamp + minutes * 60_000);
    return `${result.getUTCFullYear()}-${twoDigits(result.getUTCMonth() + 1)}-${twoDigits(result.getUTCDate())}T${twoDigits(result.getUTCHours())}:${twoDigits(result.getUTCMinutes())}`;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp + minutes * 60_000).toISOString() : null;
}

export function formatDuration(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (!hours) return `${rest} мин`;
  if (!rest) return `${hours} ч`;
  return `${hours} ч ${rest} мин`;
}

function twoDigits(value: number): string {
  return String(value).padStart(2, "0");
}
