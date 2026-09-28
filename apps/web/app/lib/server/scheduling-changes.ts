import type { ScheduleSnapshot, SchedulingChange } from "../scheduling-changes";

export function schedulingChangeStatement(db: D1Database, organizationId: string, orderId: string, userId: string, source: SchedulingChange["source"], reason: string, before: ScheduleSnapshot | null, after: ScheduleSnapshot, now: string) {
  return db.prepare(`INSERT INTO audit_events (id,organization_id,actor_user_id,entity_type,entity_id,action,payload_json,created_at)
    VALUES (?,?,?,'work_order',?,'scheduling_changed',?,?)`)
    .bind(crypto.randomUUID(), organizationId, userId, orderId, JSON.stringify({ source, reason, before, after }), now);
}

export async function loadSchedulingChanges(db: D1Database, organizationId: string, workerId?: string) {
  const rows = await db.prepare(`SELECT a.id,a.entity_id,a.payload_json,a.created_at,u.display_name FROM audit_events a
    JOIN work_orders o ON o.id=a.entity_id LEFT JOIN users u ON u.id=a.actor_user_id
    WHERE a.organization_id=? AND o.organization_id=? AND a.entity_type='work_order' AND a.action='scheduling_changed'
      ${workerId ? "AND o.assignee_worker_id=?" : ""} ORDER BY a.created_at DESC,a.rowid DESC`)
    .bind(organizationId, organizationId, ...(workerId ? [workerId] : [])).all<{ id: string; entity_id: string; payload_json: string; created_at: string; display_name: string | null }>();
  const result = new Map<string, SchedulingChange[]>();
  for (const row of rows.results) {
    const payload = JSON.parse(row.payload_json) as Pick<SchedulingChange, "source" | "reason" | "before" | "after">;
    const item = { id: row.id, createdAt: row.created_at, actor: row.display_name ?? "Система", ...payload };
    result.set(row.entity_id, [...result.get(row.entity_id) ?? [], item]);
  }
  return result;
}
