import type { BrigadeEquipment } from "../brigade-equipment";
import type { EquipmentSnapshot } from "../work-catalog";
import { loadOrderCompositions } from "./work-order-composition";

export async function departmentEquipment(db: D1Database, organizationId: string) {
  const [issued, started] = await Promise.all([
    db.prepare(`SELECT e.* FROM worker_day_equipment e JOIN workers w ON w.id=e.worker_id WHERE w.organization_id=?`)
      .bind(organizationId).all<{ worker_id:string;service_date:string;departed_at:string;equipment_json:string|null;source:string }>(),
    db.prepare(`SELECT assignee_worker_id AS worker_id,SUBSTR(scheduled_start,1,10) AS service_date,MIN(updated_at) AS departed_at
      FROM work_orders WHERE organization_id=? AND assignee_worker_id IS NOT NULL AND status IN ('en_route','in_progress','paused','completed','confirmed')
      GROUP BY assignee_worker_id,SUBSTR(scheduled_start,1,10)`).bind(organizationId).all<{worker_id:string;service_date:string;departed_at:string}>(),
  ]);
  const byWorker = new Map<string, Record<string, BrigadeEquipment>>();
  for (const row of started.results) byWorker.set(row.worker_id,{...byWorker.get(row.worker_id),[row.service_date]:{departedAt:row.departed_at,items:null,source:"unknown"}});
  for (const row of issued.results) byWorker.set(row.worker_id,{...byWorker.get(row.worker_id),[row.service_date]:{departedAt:row.departed_at,
    items:row.equipment_json ? JSON.parse(row.equipment_json) as EquipmentSnapshot[] : null,source:row.source}});
  return byWorker;
}

export async function plannedEquipment(db: D1Database, organizationId: string, workerId: string, date: string) {
  const orders=await db.prepare("SELECT id FROM work_orders WHERE organization_id=? AND assignee_worker_id=? AND SUBSTR(scheduled_start,1,10)=? AND status<>'cancelled' ORDER BY id")
    .bind(organizationId,workerId,date).all<{id:string}>();
  const composition=await loadOrderCompositions(db,organizationId);
  const items=new Map<string,EquipmentSnapshot>();
  for(const order of orders.results) for(const item of composition.get(order.id)?.equipment ?? []) if(!items.has(item.equipmentId)) items.set(item.equipmentId,{...item,quantity:null});
  return {items:[...items.values()],orderIds:orders.results.map(o=>o.id)};
}

export const equipmentRevisionSql = `json_array(w.id,w.updated_at,
  (SELECT json_group_array(json_array(id,revision)) FROM (SELECT id,revision FROM work_orders WHERE assignee_worker_id=w.id ORDER BY id)),
  (SELECT json_group_array(json_array(service_date,equipment_json,updated_at)) FROM (SELECT * FROM worker_day_equipment WHERE worker_id=w.id ORDER BY service_date)))`;
