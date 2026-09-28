import type { Engineer } from "./data";
import type { PlanningAssignmentChange } from "./planning-types";

/** Removed jobs are comparison items, never active visits or mileage. */
export function appendRemovedAssignments(engineers: readonly Engineer[], changes: readonly PlanningAssignmentChange[]): Engineer[] {
  const result = engineers.map(engineer => ({ ...engineer, removedAssignments: [] as NonNullable<Engineer["removedAssignments"]> }));
  for (const change of changes) {
    const id = change.before.workerId;
    if (!id || id === change.after.workerId) continue;
    let engineer = result.find(item => item.id === id);
    if (!engineer) {
      engineer = { id, name: change.before.workerName, initials: change.before.workerName.split(/\s+/).slice(0, 2).map(word => word[0]).join(""),
        vehicle: "", load: 0, accent: "violet", visits: [], removedAssignments: [] };
      result.push(engineer);
    }
    engineer.removedAssignments.push({ requestId: change.jobId, label: change.label,
      reason: `${change.after.workerId ? `Передана ${change.after.workerName}.` : "Сейчас не назначена."} ${change.reason}` });
  }
  return result;
}
