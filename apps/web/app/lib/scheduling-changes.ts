import { scheduleTimeToInstant } from "./regional-time";

export type ScheduleSnapshot = { workerId: string | null; workerName: string; start: string; end: string | null; timezone: string; windowStart: string | null; windowEnd: string | null };
export type SchedulingChange = { id: string; createdAt: string; actor: string; source: "manual" | "planning"; reason: string; before: ScheduleSnapshot | null; after: ScheduleSnapshot };
export type ScheduleConflict = { requestId: string; startAt: string; endAt: string; detail: string };
export type ScheduledRequest = { id: string; number?: string; assigneeId?: string; status: string; dateTime: string; schedulingTimezone?: string; serviceDurationMinutes?: number };

/** Half-open service intervals: 10:00–11:00 and 11:00–12:00 do not overlap.
 * Road-time feasibility is a separate constraint and must not be called overlap.
 */
export function findServiceConflicts(candidate: ScheduledRequest, requests: readonly ScheduledRequest[], fallbackTimezone: string): ScheduleConflict[] {
  if (!candidate.assigneeId || candidate.status === "cancelled") return [];
  const interval = (request: ScheduledRequest) => {
    if (!request.serviceDurationMinutes || !request.dateTime) return null;
    try {
      const start = Date.parse(scheduleTimeToInstant(request.dateTime, request.schedulingTimezone || fallbackTimezone));
      return { start, end: start + request.serviceDurationMinutes * 60000 };
    } catch { return null; }
  };
  const own = interval(candidate);
  if (!own) return [];
  return requests.filter(other => other.id !== candidate.id && other.assigneeId === candidate.assigneeId && other.status !== "cancelled").flatMap(other => {
    const scheduled = interval(other);
    if (!scheduled || own.start >= scheduled.end || scheduled.start >= own.end) return [];
    const startAt = new Date(Math.max(own.start, scheduled.start)).toISOString();
    const endAt = new Date(Math.min(own.end, scheduled.end)).toISOString();
    const formatter = new Intl.DateTimeFormat("ru-RU", { timeZone: candidate.schedulingTimezone || fallbackTimezone, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
    return [{ requestId: other.id, startAt, endAt, detail: `Пересечение с ${other.number ?? "Без номера"}: ${formatter.format(new Date(startAt))} — ${formatter.format(new Date(endAt))}` }];
  });
}

export function manualSchedulingReason(before: ScheduleSnapshot | null, after: ScheduleSnapshot): string | null {
  const reasons: string[] = [];
  if (before?.workerId !== after.workerId && (before || after.workerId)) {
    reasons.push(after.workerId ? `Назначена вручную: ${after.workerName}${before?.workerId ? `; снята с ${before.workerName}` : ""}.` : `Назначение снято вручную с ${before!.workerName}.`);
  }
  const sameMoment = (left: string | null, right: string | null) => {
    if (left === right) return true;
    if (!left || !right || !before) return false;
    return scheduleTimeToInstant(left, before.timezone) === scheduleTimeToInstant(right, after.timezone);
  };
  if (before && (!sameMoment(before.start, after.start) || !sameMoment(before.end, after.end))) reasons.push("Диспетчер изменил плановое время работ.");
  if (before && (!sameMoment(before.windowStart, after.windowStart) || !sameMoment(before.windowEnd, after.windowEnd))) reasons.push("Диспетчер изменил клиентское окно.");
  return reasons.length ? reasons.join(" ") : null;
}
