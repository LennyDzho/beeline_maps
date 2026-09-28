import { NextResponse } from "next/server";
import { badRequest, conflict, isApiError, requireApiContext, serverError } from "@/app/api/_shared";
import { loadOrderCompositions } from "@/app/lib/server/work-order-composition";
import { readPlanningInput } from "@/app/lib/server/planning/input-revisions";
import { buildEquipmentReport } from "@/app/lib/equipment-report";
import { departmentEquipment } from "@/app/lib/server/brigade-equipment";

export async function GET(request: Request) {
  try {
    const ctx = await requireApiContext(request, "planning.manage"); if (isApiError(ctx)) return ctx;
    const params = new URL(request.url).searchParams;
    const date = params.get("date") ?? ""; const planId = params.get("planId"); const workerId = params.get("workerId");
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date) return badRequest("Укажите дату отчёта.");
    let draft = false;
    if (planId) {
      const plan = await ctx.database.prepare("SELECT status, input_revision_json FROM route_plans WHERE id=? AND organization_id=? AND service_date=?")
        .bind(planId, ctx.organizationId, date).first<{ status: string; input_revision_json: string }>();
      if (!plan) return NextResponse.json({ message: "План недоступен." }, { status: 404 });
      if (!["draft", "published"].includes(plan.status)) return conflict("План архивирован. Обновите расчёт.");
      draft = plan.status === "draft";
      if (draft && plan.input_revision_json !== await readPlanningInput(ctx.database, ctx.organizationId)) return conflict("Исходные данные плана изменились. Пересчитайте план перед отчётом.");
    }
    const rows = await ctx.database.prepare(`SELECT o.id, o.number, o.status, o.assignee_worker_id, w.full_name AS worker_name FROM work_orders o
      LEFT JOIN workers w ON w.id=o.assignee_worker_id WHERE o.organization_id=? AND SUBSTR(o.scheduled_start,1,10)=? AND o.status<>'cancelled' ORDER BY o.id`)
      .bind(ctx.organizationId, date).all<{ id: string; number: string; status: string; assignee_worker_id: string | null; worker_name: string | null }>();
    const stops = draft ? (await ctx.database.prepare(`SELECT s.work_order_id, s.worker_id, w.full_name FROM route_stops s JOIN workers w ON w.id=s.worker_id WHERE s.route_plan_id=?`)
      .bind(planId).all<{ work_order_id: string; worker_id: string; full_name: string }>()).results : [];
    const compositions = await loadOrderCompositions(ctx.database, ctx.organizationId);
    const orders = rows.results.map(row => {
      const stop = stops.find(stop => stop.work_order_id === row.id);
      const candidate = draft && ["new", "assigned"].includes(row.status);
      return { id: row.id, number: row.number, workerId: candidate ? stop?.worker_id ?? null : row.assignee_worker_id,
        workerName: candidate ? stop?.full_name ?? "Не назначены" : row.worker_name ?? "Не назначены", equipment: compositions.get(row.id)!.equipment };
    }).filter(item => !workerId || (workerId === "unassigned" ? item.workerId === null : item.workerId === workerId));
    const report=buildEquipmentReport(orders,date,planId),issued=await departmentEquipment(ctx.database,ctx.organizationId);
    for(const group of report.groups) if(group.workerId) group.issued=issued.get(group.workerId)?.[date];
    return NextResponse.json({ report });
  } catch (error) { return serverError(error); }
}
