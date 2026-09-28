import { NextResponse } from "next/server";
import { badRequest, isApiError, readJsonObject, requireApiContext, serverError } from "@/app/api/_shared";
import { workerAvailability, activityRevisionSql } from "@/app/lib/server/planning/availability";
import { regionalTimeToInstant } from "@/app/lib/regional-time";
import { GeocodingError, geocodeAddress } from "@/app/lib/server/geocoding";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const context=await requireApiContext(request,"engineers.manage");
    if (isApiError(context)) return context;
    const item=await workerAvailability(context.database,context.organizationId,new URL(request.url).searchParams.get("workerId") ?? "");
    return item ? NextResponse.json(item,{headers:{"Cache-Control":"no-store"}}) : NextResponse.json({message:"Исполнитель не найден."},{status:404});
  } catch (error) { return serverError(error); }
}

export async function PUT(request: Request) {
  try {
    const context=await requireApiContext(request,"engineers.manage");
    if (isApiError(context)) return context;
    const body=await readJsonObject(request);
    if (!body || typeof body.workerId!=="string" || typeof body.activityRevision!=="string") return badRequest("Обновите карточку исполнителя.");
    const current=await workerAvailability(context.database,context.organizationId,body.workerId);
    if (!current) return NextResponse.json({message:"Исполнитель не найден."},{status:404});
    if (current.activityRevision!==body.activityRevision) return changed();
    let availableAt:string|null=null;
    let address="",point:{lat:number;lon:number}|null=null;
    if (body.availableAt!==null) {
      if (typeof body.availableAt!=="string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/u.test(body.availableAt)
        || typeof body.address!=="string" || !body.address.trim() || body.address.length>1000) return badRequest("Укажите время освобождения и адрес продолжения маршрута.");
      try { availableAt=regionalTimeToInstant(body.availableAt,current.timezone); }
      catch { return badRequest("Некорректное время освобождения в регионе исполнителя."); }
      address=body.address.trim();
      if (current.estimate?.address===address) point=current.estimate.point;
      else point=(await geocodeAddress(address)).point;
    }
    const now=new Date().toISOString(),db=context.database;
    const guard=db.prepare(`INSERT INTO mobile_commands (user_id,operation_id,fingerprint,accepted,created_at)
      SELECT ?,?,'worker-availability',CASE WHEN EXISTS(SELECT 1 FROM workers w WHERE w.id=? AND w.organization_id=? AND ${activityRevisionSql}=?) THEN 1 ELSE 0 END,?`)
      .bind(context.user.id,crypto.randomUUID(),body.workerId,context.organizationId,current.activityRevision,now);
    const write=availableAt && point ? db.prepare(`INSERT INTO worker_planning_availability
      (worker_id,available_at,address,latitude,longitude,activity_revision,updated_by_user_id,updated_at) VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(worker_id) DO UPDATE SET available_at=excluded.available_at,address=excluded.address,latitude=excluded.latitude,longitude=excluded.longitude,
        activity_revision=excluded.activity_revision,updated_by_user_id=excluded.updated_by_user_id,updated_at=excluded.updated_at`)
      .bind(body.workerId,availableAt,address,point.lat,point.lon,current.activityRevision,context.user.id,now)
      : db.prepare("DELETE FROM worker_planning_availability WHERE worker_id=?").bind(body.workerId);
    try {
      await db.batch([guard,write,db.prepare(`INSERT INTO audit_events (id,organization_id,actor_user_id,entity_type,entity_id,action,payload_json,created_at)
        VALUES (?,?,?,'worker',?,'planning_availability_changed',?,?)`).bind(crypto.randomUUID(),context.organizationId,context.user.id,body.workerId,JSON.stringify({availableAt,address,point}),now)]);
    } catch (error) {
      if ((await workerAvailability(db,context.organizationId,body.workerId))?.activityRevision!==current.activityRevision) return changed();
      throw error;
    }
    return NextResponse.json(await workerAvailability(db,context.organizationId,body.workerId));
  } catch (error) { return error instanceof GeocodingError ? NextResponse.json({message:error.message},{status:422}) : serverError(error); }
}

function changed() { return NextResponse.json({message:"Занятость исполнителя изменилась. Обновите карточку и уточните оценку."},{status:409}); }
