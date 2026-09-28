import type { Engineer } from "./data.js";

/** Keep personnel visible after an OSRM calculation even when no job fits their route. */
export function includeUnroutedEngineers(cards: Engineer[], workers: { id: string; name: string; vehicle: string }[]): Engineer[] {
  const routedIds = new Set(cards.map((card) => card.id));
  return [...cards, ...workers.filter((worker) => !routedIds.has(worker.id)).map((worker): Engineer => ({
    id: worker.id, name: worker.name, vehicle: worker.vehicle,
    initials: worker.name.trim().split(/\s+/u).slice(0, 2).map((part) => part[0]).join(""),
    load: 0, accent: "violet", visits: [], routeSummary: "Нет назначений в этом расчёте",
  }))];
}
