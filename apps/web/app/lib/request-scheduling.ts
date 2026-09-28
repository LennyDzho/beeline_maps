import { instantToRegionalTime, regionalTimeToInstant } from "./regional-time";

export type ClientWindowFields = { clientWindowStart?: string; clientWindowEnd?: string };

export function emergencyWindow(dateTime: string, timezone: string) {
  const date=dateTime.slice(0,10);
  const next=new Date(Date.parse(`${date}T00:00:00Z`)+86_400_000).toISOString().slice(0,10);
  return {windowStart:regionalTimeToInstant(`${date}T00:00`,timezone),
    windowEnd:new Date(Date.parse(regionalTimeToInstant(`${next}T00:00`,timezone))-1).toISOString()};
}

export function requestScheduling(fields: ClientWindowFields, dateTime: string, durationMinutes: number, timezone: string,
  previous?: { client_window_start: string | null; client_window_end: string | null }, isEmergency=false) {
  const startInstant = regionalTimeToInstant(dateTime, timezone);
  const endInstant = new Date(Date.parse(startInstant) + durationMinutes * 60_000).toISOString();
  const hasWindow = fields.clientWindowStart !== undefined || fields.clientWindowEnd !== undefined;
  const start = hasWindow ? fields.clientWindowStart ?? "" : previous?.client_window_start ?? "";
  const end = hasWindow ? fields.clientWindowEnd ?? "" : previous?.client_window_end ?? "";
  if (Boolean(start) !== Boolean(end)) throw new RangeError("Укажите обе границы клиентского окна.");
  const windowStart = start ? (hasWindow ? regionalTimeToInstant(start, timezone) : start) : null;
  const windowEnd = end ? (hasWindow ? regionalTimeToInstant(end, timezone) : end) : null;
  if (windowStart && windowEnd && Date.parse(windowStart) > Date.parse(windowEnd)) throw new RangeError("Конец клиентского окна раньше начала.");
  return { timezone, windowStart, windowEnd, ...(isEmergency ? emergencyWindow(dateTime,timezone) : {}),
    scheduledEnd: instantToRegionalTime(endInstant, timezone).slice(0, 16) };
}
