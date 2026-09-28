import type { Engineer } from "./data.js";

type Request = { id: string; number?: string; status: string; dateTime: string; assignee: string; assigneeId?: string };
type Worker = { id: string; name: string; vehicle: string; load: number };

/** Paused work keeps its owner, is never a route stop, and remains visible even without a calculated route. */
export function appendPausedVisits(cards: Engineer[], requests: Request[], workers: Worker[]): Engineer[] {
  const paused = requests.filter(request => request.status === "paused");
  const pausedIds = new Set(paused.map(request => request.id));
  const result = cards.map(card => ({ ...card, visits: card.visits.filter(visit => !visit.requestId || !pausedIds.has(visit.requestId)) }));
  for (const worker of workers) {
    const owned = paused.filter(request => request.assigneeId ? request.assigneeId === worker.id : request.assignee === worker.name)
      .sort((a, b) => a.dateTime.localeCompare(b.dateTime) || a.id.localeCompare(b.id));
    if (!owned.length) continue;
    let card = result.find(item => item.id === worker.id);
    if (!card) {
      card = { id: worker.id, name: worker.name, vehicle: worker.vehicle, load: worker.load, accent: "violet",
        initials: worker.name.split(/\s+/u).slice(0, 2).map(part => part[0]).join(""), visits: [] };
      result.push(card);
    }
    card.visits.push(...owned.map(request => ({ requestId: request.id, time: request.dateTime.slice(11, 16),
      label: `Заявка ${request.number ?? "Без номера"}`, paused: true })));
  }
  return result;
}
