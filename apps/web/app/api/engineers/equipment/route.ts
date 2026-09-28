import { NextResponse } from "next/server";
import { badRequest, conflict, isApiError, readJsonObject, requireApiContext, serverError } from "@/app/api/_shared";
import { departmentEquipment, plannedEquipment, equipmentRevisionSql } from "@/app/lib/server/brigade-equipment";
import { listEquipmentItems } from "@/app/lib/server/work-catalog";
import { isUniqueIds } from "@/app/lib/work-catalog";
import { instantToRegionalTime } from "@/app/lib/regional-time";

async function read(db:D1Database,org:string,workerId:string,requestedDate:string|null) {
  const worker=await db.prepare(`SELECT w.id,COALESCE(w.timezone,o.timezone) AS timezone,${equipmentRevisionSql} AS revision
    FROM workers w JOIN organizations o ON o.id=w.organization_id WHERE w.id=? AND w.organization_id=?`).bind(workerId,org).first<{id:string;timezone:string;revision:string}>();
  if(!worker) return null;
  const last=await db.prepare("SELECT SUBSTR(scheduled_start,1,10) AS date FROM work_orders WHERE assignee_worker_id=? AND status<>'cancelled' ORDER BY scheduled_start DESC LIMIT 1").bind(workerId).first<{date:string}>();
  const date=requestedDate ?? last?.date ?? instantToRegionalTime(new Date().toISOString(),worker.timezone).slice(0,10);
  if(!/^\d{4}-\d{2}-\d{2}$/u.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0,10)!==date) return null;
  const [all,planned,catalog]=await Promise.all([departmentEquipment(db,org),plannedEquipment(db,org,workerId,date),listEquipmentItems(db)]);
  return {workerId,date,timezone:worker.timezone,revision:worker.revision,issued:all.get(workerId)?.[date] ?? null,planned,catalog};
}
export async function GET(request:Request) {
  try {
    const ctx=await requireApiContext(request,"engineers.manage");if(isApiError(ctx))return ctx;
    const params=new URL(request.url).searchParams;
    const result=await read(ctx.database,ctx.organizationId,params.get("workerId") ?? "",params.get("date"));
    return result?NextResponse.json(result,{headers:{"Cache-Control":"no-store"}}):NextResponse.json({message:"Исполнитель или день недоступен."},{status:404});
  }catch(error){return serverError(error);}
}
export async function PUT(request:Request) {
  try {
    const ctx=await requireApiContext(request,"engineers.manage");if(isApiError(ctx))return ctx;
    const body=await readJsonObject(request);
    if(!body || typeof body.workerId!=="string" || typeof body.date!=="string" || typeof body.revision!=="string" || !isUniqueIds(body.equipmentIds)
      || typeof body.reason!=="string" || body.reason.trim().length<3 || body.reason.length>1000) return badRequest("Укажите день, комплект оборудования и причину фиксации.");
    const current=await read(ctx.database,ctx.organizationId,body.workerId,body.date);if(!current)return NextResponse.json({message:"Исполнитель недоступен."},{status:404});
    if(current.revision!==body.revision)return conflict("Комплект или задания изменились. Обновите карточку.");
    const selected=body.equipmentIds.map(id=>current.catalog.find(e=>e.id===id));
    if(selected.some(item=>!item || !item.active && !current.issued?.items?.some(e=>e.equipmentId===item.id)))return badRequest("В комплекте есть недоступное оборудование.");
    const items=selected.map(item=>({equipmentId:item!.id,name:item!.name,unit:item!.unit,usage:item!.usage,quantity:null}));
    const now=new Date().toISOString(),db=ctx.database;
    try {await db.batch([
      db.prepare(`INSERT INTO mobile_commands (user_id,operation_id,fingerprint,accepted,created_at) SELECT ?,?,'equipment-issue',CASE WHEN EXISTS
        (SELECT 1 FROM workers w WHERE w.id=? AND w.organization_id=? AND ${equipmentRevisionSql}=?) THEN 1 ELSE 0 END,?`)
        .bind(ctx.user.id,crypto.randomUUID(),body.workerId,ctx.organizationId,body.revision,now),
      db.prepare(`INSERT INTO worker_day_equipment (worker_id,service_date,departed_at,equipment_json,source,recorded_by_user_id,updated_at)
        VALUES (?,?,?,?,'dispatcher',?,?) ON CONFLICT(worker_id,service_date) DO UPDATE SET equipment_json=excluded.equipment_json,source=excluded.source,recorded_by_user_id=excluded.recorded_by_user_id,updated_at=excluded.updated_at`)
        .bind(body.workerId,body.date,current.issued?.departedAt ?? now,JSON.stringify(items),ctx.user.id,now),
      db.prepare(`INSERT INTO audit_events (id,organization_id,actor_user_id,entity_type,entity_id,action,payload_json,created_at)
        VALUES (?,?,?,'worker',?,'equipment_issued',?,?)`).bind(crypto.randomUUID(),ctx.organizationId,ctx.user.id,body.workerId,JSON.stringify({serviceDate:body.date,reason:body.reason.trim(),before:current.issued,items}),now),
    ]);} catch(error){if(String(error).includes("mobile_command_precondition"))return conflict("Комплект или задания изменились. Обновите карточку.");throw error;}
    return NextResponse.json(await read(db,ctx.organizationId,body.workerId,body.date));
  }catch(error){return serverError(error);}
}
