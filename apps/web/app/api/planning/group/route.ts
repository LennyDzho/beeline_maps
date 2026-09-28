import { NextResponse } from "next/server";
import { badRequest,isApiError,readJsonObject,requireApiContext,serverError } from "@/app/api/_shared";
import { listPlanningDepartments,publishCommonPlan,readCommonPlan,recalculateCommonPlan } from "@/app/lib/server/planning/common-plan";
import { planningErrorResponse } from "@/app/lib/server/planning/planning-service";

export const dynamic="force-dynamic";
function failure(error:unknown) { const known=planningErrorResponse(error); return known ? NextResponse.json({message:known.message},{status:known.status}) : serverError(error); }
async function requireCommonContext(request:Request) {
  const ctx=await requireApiContext(request);if(isApiError(ctx))return ctx;
  if(!(await listPlanningDepartments(ctx.database,ctx.user.id)).length)return NextResponse.json({message:"Нет доступных подразделений для планирования."},{status:403});
  return ctx;
}
export async function GET(request:Request) {
  try { const ctx=await requireCommonContext(request); if(isApiError(ctx)) return ctx;
    const params=new URL(request.url).searchParams;
    return NextResponse.json(await readCommonPlan(ctx.database,ctx.user.id,params.get("date") ?? "",undefined,params.get("publishedOnly")==="1"),{headers:{"Cache-Control":"no-store"}});
  } catch(error) { return failure(error); }
}
export async function POST(request:Request) {
  try { const ctx=await requireCommonContext(request); if(isApiError(ctx)) return ctx;
    const body=await readJsonObject(request);
    if(!body || typeof body.serviceDate!=="string" || (body.eventTime!==undefined && typeof body.eventTime!=="string")) return badRequest("Укажите дату и время события.");
    return NextResponse.json({result:await recalculateCommonPlan(ctx.database,ctx.user.id,body.serviceDate,body.eventTime as string|undefined,request.signal)},{status:201});
  } catch(error) { return failure(error); }
}
export async function PUT(request:Request) {
  try { const ctx=await requireCommonContext(request); if(isApiError(ctx)) return ctx;
    const body=await readJsonObject(request), ids=body?.clientNotifiedApprovalIds ?? [];
    if(!body || typeof body.planId!=="string" || !body.planId || !Array.isArray(ids) || ids.some(id=>typeof id!=="string") || new Set(ids).size!==ids.length) return badRequest();
    return NextResponse.json(await publishCommonPlan(ctx.database,ctx.user.id,body.planId,ids));
  } catch(error) { return failure(error); }
}
