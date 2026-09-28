/** Local form values have no implicit browser/server timezone. */
export function isRegionalTimezone(value: unknown): value is string {
  if (typeof value !== "string" || !value || value.length > 100) return false;
  try { new Intl.DateTimeFormat("en", { timeZone: value }).format(0); return true; }
  catch { return false; }
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(timezone: string) {
  let value = formatters.get(timezone);
  if (!value) {
    value = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
    if (formatters.size < 100) formatters.set(timezone, value);
  }
  return value;
}

export function instantToRegionalTime(instant: string, timezone: string): string {
  // An absolute instant is required: Date.parse must never use the host timezone.
  if (!/(Z|[+-]\d{2}:\d{2})$/u.test(instant) || !Number.isFinite(Date.parse(instant))) throw new RangeError("Требуется абсолютное время.");
  const parts = formatter(timezone).formatToParts(new Date(instant));
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(item => item.type === type)!.value;
  return `${part("year")}-${part("month")}-${part("day")}T${part("hour")}:${part("minute")}:${part("second")}`;
}

export function regionalTimeToInstant(local: string, timezone: string): string {
  if (!isRegionalTimezone(timezone)) throw new RangeError("Неизвестный часовой пояс.");
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/u.exec(local);
  if (!match) throw new RangeError("Укажите местные дату и время.");
  const normalized = `${local.slice(0, 16)}:${match[6] ?? "00"}`;
  const wall = Date.parse(normalized + "Z");
  if (!Number.isFinite(wall) || new Date(wall).toISOString().slice(0, 19) !== normalized) throw new RangeError("Некорректные дата или время.");
  // Probe both sides of an offset transition. Gaps and ambiguous local times
  // are rejected instead of silently moving a customer's appointment.
  const offsets = new Set<number>();
  for (const hours of [-36, -12, 0, 12, 36]) {
    const probe = wall + hours * 3_600_000;
    const rendered = instantToRegionalTime(new Date(probe).toISOString(), timezone);
    offsets.add(Date.parse(rendered + "Z") - probe);
  }
  const matches = [...offsets].map(offset => new Date(wall - offset).toISOString())
    .filter(instant => instantToRegionalTime(instant, timezone) === normalized);
  if (matches.length !== 1) throw new RangeError("Это местное время отсутствует или неоднозначно из-за смены часового пояса.");
  return matches[0]!;
}

/** Existing timezone-less schedule values are interpreted only in their saved region. */
export function scheduleTimeToInstant(value: string, timezone: string): string {
  if (/(Z|[+-]\d{2}:\d{2})$/u.test(value)) {
    if (!Number.isFinite(Date.parse(value))) throw new RangeError("Некорректное время.");
    return new Date(value).toISOString();
  }
  return regionalTimeToInstant(value, timezone);
}
