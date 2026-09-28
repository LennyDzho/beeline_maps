import { NextResponse } from "next/server";
import { badRequest, isApiError, readJsonObject, requireApiContext, serverError } from "@/app/api/_shared";
import { planningErrorResponse, publishPlan, readSavedPlan, recalculatePlan } from "@/app/lib/server/planning/planning-service";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const context = await requireApiContext(request, "planning.manage");
    if (isApiError(context)) return context;
    return NextResponse.json(await readSavedPlan(context.database, context.organizationId, new URL(request.url).searchParams.get("date") ?? ""), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const known = planningErrorResponse(error);
    return known ? NextResponse.json({ message: known.message }, { status: known.status }) : serverError(error);
  }
}

export async function POST(request: Request) {
  try {
    const context = await requireApiContext(request, "planning.manage");
    if (isApiError(context)) return context;
    const body = await readJsonObject(request);
    if (!body || typeof body.serviceDate !== "string") return badRequest("Укажите дату планирования.");
    if (body.eventAt !== undefined && typeof body.eventAt !== "string") return badRequest("Некорректное время перепланирования.");
    const result = await recalculatePlan(context.database, context.organizationId, context.user.id, body.serviceDate,body.eventAt as string|undefined);
    return NextResponse.json({ result }, { status: 201 });
  } catch (error) {
    const known = planningErrorResponse(error);
    return known ? NextResponse.json({ message: known.message }, { status: known.status }) : serverError(error);
  }
}

export async function PUT(request: Request) {
  try {
    const context = await requireApiContext(request, "planning.manage");
    if (isApiError(context)) return context;
    const body = await readJsonObject(request);
    if (!body || typeof body.planId !== "string" || !body.planId.trim()) return badRequest("Укажите черновик плана.");
    const common = await context.database.prepare(`SELECT 1 FROM route_plan_groups g,json_each(g.member_plans_json) m
      WHERE json_extract(m.value,'$.planId')=? LIMIT 1`).bind(body.planId).first();
    if (common) return NextResponse.json({message:"Этот расчёт входит в общий план. Опубликуйте все подразделения вместе."},{status:409});
    const acknowledgements = body.clientNotifiedApprovalIds ?? [];
    if (!Array.isArray(acknowledgements) || acknowledgements.some(id => typeof id !== "string") || new Set(acknowledgements).size !== acknowledgements.length) return badRequest("Некорректный список подтверждений сообщения клиентам.");
    return NextResponse.json(await publishPlan(context.database, context.organizationId, context.user.id, body.planId, acknowledgements));
  } catch (error) {
    const known = planningErrorResponse(error);
    return known ? NextResponse.json({ message: known.message }, { status: known.status }) : serverError(error);
  }
}
