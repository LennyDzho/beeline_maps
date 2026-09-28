import { WORKER_TRANSPORT_SQL, WORKER_PLATE_SQL } from "./planning/worker-travel-policy";
import type { EngineerVehicle } from "@/app/engineers/engineer-editor";
import { WorkCatalogError } from "./work-catalog";

export async function listWorkerVehicles(db: D1Database, organizationId: string): Promise<EngineerVehicle[]> {
  const rows = await db.prepare(`SELECT id,name,plate,assigned_worker_id AS assignedWorkerId,status,condition FROM resources
    WHERE organization_id=? AND type IN ('Фургон','Легковой') ORDER BY plate,id`).bind(organizationId).all<EngineerVehicle>();
  return rows.results;
}

/** Guard and mutation run in the same D1 transaction as the worker update. */
export async function workerVehicleStatements(db: D1Database, organizationId: string, workerId: string, resourceId: string | undefined, now: string) {
  const syncTransport = db.prepare(`UPDATE workers SET transport_mode=${WORKER_TRANSPORT_SQL}, travel_mode=${WORKER_TRANSPORT_SQL}, transport_details=${WORKER_PLATE_SQL} WHERE id=? AND organization_id=?`).bind(workerId, organizationId);
  if (resourceId === undefined) return [syncTransport];
  const guardId = crypto.randomUUID();
  const availableSql = `SELECT 1 FROM resources WHERE id=? AND organization_id=? AND type IN ('Фургон','Легковой')
    AND (assigned_worker_id=? OR (assigned_worker_id IS NULL AND status<>'repair' AND condition='serviceable'))`;
  if (resourceId && !await db.prepare(availableSql).bind(resourceId,organizationId,workerId).first()) {
    throw new WorkCatalogError("Автомобиль недоступен: он уже закреплён, находится в ремонте или относится к другому подразделению.",409);
  }
  return [
    ...(resourceId ? [db.prepare(`INSERT INTO resource_assignment_guards(id,available) SELECT ?,EXISTS(${availableSql})`).bind(guardId,resourceId,organizationId,workerId)] : []),
    db.prepare("UPDATE resources SET assigned_worker_id=NULL, updated_at=? WHERE assigned_worker_id=? AND organization_id=? AND type IN ('Фургон','Легковой') AND id<>?").bind(now,workerId,organizationId,resourceId),
    ...(resourceId ? [db.prepare("UPDATE resources SET assigned_worker_id=?, updated_at=? WHERE id=? AND organization_id=?").bind(workerId,now,resourceId,organizationId), db.prepare("DELETE FROM resource_assignment_guards WHERE id=?").bind(guardId)] : []),
    syncTransport,
  ];
}
