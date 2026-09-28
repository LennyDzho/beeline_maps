// A deterministic snapshot of planner inputs. Keep it in SQL so publication can
// compare and assert it inside the SAME D1 batch as the writes.
const tables = [
  ["work_orders", "id,revision", "organization_id", "id"],
  ["workers", "id,updated_at,timezone,start_address,start_latitude,start_longitude,work_schedule_id,shift_status,active,transport_mode,travel_mode", "organization_id", "id"],
  ["worker_day_equipment", "worker_id,service_date,departed_at,equipment_json,source,recorded_by_user_id,updated_at", "worker_id IN (SELECT id FROM workers WHERE organization_id", "worker_id,service_date"],
  ["worker_planning_availability", "worker_id,available_at,address,latitude,longitude,activity_revision,updated_at", "worker_id IN (SELECT id FROM workers WHERE organization_id", "worker_id"],
  ["organizations", "id,timezone,office_address,office_latitude,office_longitude,status", "id", "id"],
  ["system_settings", "optimization_engine,solver_policy,travel_matrix_provider,updated_at", "global", "id"],
  ["work_schedules", "id,active,updated_at", "organization_id", "id"],
  ["work_schedule_days", "schedule_id,weekday,enabled,start_time,end_time,break_start,break_end", "schedule_id IN (SELECT id FROM work_schedules WHERE organization_id", "schedule_id,weekday"],
  ["worker_skills", "worker_id,skill_id,level", "worker_id IN (SELECT id FROM workers WHERE organization_id", "worker_id,skill_id"],
  ["worker_qualifications", "worker_id,qualification_id,status,expires_at", "worker_id IN (SELECT id FROM workers WHERE organization_id", "worker_id,qualification_id"],
  ["skills", "id,name,active", "global", "id"],
  ["qualifications", "id,name,active", "global", "id"],
  ["work_types", "id,name,active,updated_at", "global", "id"],
  ["work_type_versions", "id,work_type_id,version,status,planned_duration_minutes,is_emergency", "global", "id"],
  ["work_type_version_skills", "work_type_version_id,skill_id", "global", "work_type_version_id,skill_id"],
  ["work_type_version_qualifications", "work_type_version_id,qualification_id", "global", "work_type_version_id,qualification_id"],
  ["work_categories", "id,name,active,service_duration_minutes,duration_source,updated_at", "global", "id"],
  ["category_work_types", "category_id,work_type_id", "global", "category_id,work_type_id"],
  ["worker_work_competencies", "worker_id,category_id,work_type_id", "worker_id IN (SELECT id FROM workers WHERE organization_id", "worker_id,category_id,work_type_id"],
  ["work_order_work_types", "work_order_id,work_type_version_id,sequence,name_snapshot", "work_order_id IN (SELECT id FROM work_orders WHERE organization_id", "work_order_id,sequence"],
  ["work_order_equipment", "work_order_id,equipment_id,quantity,name_snapshot,unit_snapshot,usage_snapshot", "work_order_id IN (SELECT id FROM work_orders WHERE organization_id", "work_order_id,equipment_id"],
  ["work_type_version_equipment", "work_type_version_id,equipment_id,quantity,name_snapshot,unit_snapshot,usage_snapshot", "global", "work_type_version_id,equipment_id"],
  ["equipment_items", "id,name,unit,usage,active,updated_at", "global", "id"],
  ["resources", "id,updated_at,assigned_worker_id,condition,status", "organization_id", "id"],
  ["service_objects", "id,updated_at,latitude,longitude,address", "organization_id", "id"],
] as const;

export const planningInputExpression = `json_array(${tables.map(([table, columns, scope, order]) =>
  `(SELECT json_group_array(json_array(${columns})) FROM (SELECT * FROM ${table} WHERE ${scope === "global" ? "1" : `${scope} = scope.organization_id${scope.includes(" IN (") ? ")" : ""}`} ORDER BY ${order}))`
).join(",")},'resource-transport/v1')`;

export async function readPlanningInput(database: D1Database, organizationId: string) {
  const row = await database.prepare(`SELECT ${planningInputExpression} AS snapshot FROM (SELECT ? AS organization_id) scope`)
    .bind(organizationId).first<{ snapshot: string }>();
  return row!.snapshot;
}

export function publicationGuard(database: D1Database, organizationId: string, userId: string, planId: string, now: string) {
  return database.prepare(`INSERT INTO mobile_commands (user_id, operation_id, fingerprint, accepted, created_at)
    SELECT ?, ?, 'plan-publication', CASE WHEN EXISTS (
      SELECT 1 FROM route_plans plan WHERE plan.id = ? AND plan.organization_id = scope.organization_id
        AND plan.status = 'draft' AND plan.input_revision_json = ${planningInputExpression}
    ) THEN 1 ELSE 0 END, ? FROM (SELECT ? AS organization_id) scope`)
    .bind(userId, crypto.randomUUID(), planId, now, organizationId);
}
