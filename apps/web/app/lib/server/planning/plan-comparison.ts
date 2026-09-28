import type { PlanningAgent, PlanningJob, PlanProposal } from "@mmi/provider-contracts";
import type { PlanningAssignmentChange } from "@/app/dispatcher/planning-types";
import { instantToRegionalTime, scheduleTimeToInstant } from "@/app/lib/regional-time";

export type ComparisonOrder = {
  id: string; number: string; work_name: string; assignee_worker_id: string | null; assignee_name: string | null;
  scheduled_start: string; scheduled_end: string | null; scheduling_timezone: string;
  client_window_start: string | null; client_window_end: string | null; baseline_sequence: number | null; had_assignment: number;
};

/** Derive explanations from observable changes and known failed constraints.
 * Do not claim an optimal solution or invent a causal explanation from weights.
 */
export function comparePlan(rows: readonly ComparisonOrder[], jobs: readonly PlanningJob[], agents: readonly PlanningAgent[],
  workerNames: ReadonlyMap<string, string>, proposal: PlanProposal, unassignedDetails: ReadonlyMap<string, string>): PlanningAssignmentChange[] {
  const planned = new Map(proposal.routes.flatMap(route => route.visits.map((visit, index) => [visit.jobId, { agentId: route.agentId, visit, sequence: index + 1 }] as const)));
  return rows.flatMap(row => {
    const stop = planned.get(row.id);
    // The first assignment is deliberately silent.
    if (!row.assignee_worker_id && !row.had_assignment) return [];
    const before = { workerId: row.assignee_worker_id, workerName: row.assignee_name ?? "", start: row.scheduled_start, end: row.scheduled_end,
      timezone: row.scheduling_timezone, windowStart: row.client_window_start, windowEnd: row.client_window_end, sequence: row.baseline_sequence };
    const after = { ...before, workerId: stop?.agentId ?? null, workerName: stop ? workerNames.get(stop.agentId) ?? stop.agentId : "",
      start: stop ? instantToRegionalTime(stop.visit.serviceStartAt, row.scheduling_timezone).slice(0, 16) : before.start,
      end: stop ? instantToRegionalTime(stop.visit.serviceEndAt, row.scheduling_timezone).slice(0, 16) : before.end, sequence: stop?.sequence ?? null };
    const sameInstant = (a: string | null, b: string | null) => a === b || (a && b && scheduleTimeToInstant(a, row.scheduling_timezone) === scheduleTimeToInstant(b, row.scheduling_timezone));
    const workerChanged = before.workerId !== after.workerId;
    const timeChanged = !sameInstant(before.start, after.start) || !sameInstant(before.end, after.end);
    const orderChanged = before.sequence !== after.sequence;
    if (!workerChanged && !timeChanged && !orderChanged) return [];
    let reason: string;
    if (!stop) reason = unassignedDetails.get(row.id) || "Не найдено допустимое место в пересчитанном плане.";
    else if (!before.workerId) reason = "Повторное назначение при пересчёте маршрутов.";
    else {
      const oldAgent = agents.find(agent => agent.id === before.workerId);
      const job = jobs.find(job => job.id === row.id);
      const hasNewEmergency = proposal.routes.filter(route=>route.agentId===before.workerId || route.agentId===stop.agentId)
        .some(route=>route.visits.some(visit=>jobs.find(item=>item.id===visit.jobId)?.isEmergency
          && rows.find(item=>item.id===visit.jobId)?.assignee_worker_id!==route.agentId));
      if (workerChanged && !oldAgent) reason = "Прежний исполнитель недоступен в выбранном расчёте.";
      else if (workerChanged && oldAgent?.availableEquipmentIds !== undefined && job?.requiredEquipmentIds?.some(id=>!oldAgent.availableEquipmentIds!.includes(id))) reason = "У прежней бригады нет необходимого оборудования после выезда.";
      else if (workerChanged && job?.requiredSkills?.some(skill => !oldAgent?.skills.includes(skill))) reason = "У прежнего исполнителя нет всех требуемых компетенций или допусков.";
      else if (hasNewEmergency) reason = "Пересчёт маршрута при добавлении срочной аварии.";
      else if (workerChanged) reason = "Перераспределение маршрутов с учётом клиентских окон, смен и дороги.";
      else if (timeChanged) reason = "Новое время после пересчёта маршрута с учётом дороги и клиентских окон.";
      else reason = `Изменён порядок маршрута: позиция ${before.sequence} → ${after.sequence}.`;
    }
    return [{ jobId: row.id, label: `${row.work_name} · ${row.number}`, reason, before, after }];
  });
}
