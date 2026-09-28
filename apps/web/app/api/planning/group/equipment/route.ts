import { NextResponse } from "next/server";
import { isApiError,requireApiContext,serverError } from "@/app/api/_shared";
import { GET as readEquipment } from "@/app/api/planning/equipment/route";
import { listPlanningDepartments,readCommonPlan } from "@/app/lib/server/planning/common-plan";
import { planningErrorResponse } from "@/app/lib/server/planning/planning-service";
import type { EquipmentReport } from "@/app/lib/equipment-report";

export async function GET(request:Request) {
  try {
    const ctx=await requireApiContext(request); if(isApiError(ctx)) return ctx;
    const params=new URL(request.url).searchParams,date=params.get("date") ?? "",planId=params.get("planId"),filter=params.get("departmentId");
    const departments=await listPlanningDepartments(ctx.database,ctx.user.id);
    if(!departments.length || (filter && !departments.some(d=>d.id===filter))) return NextResponse.json({message:"Подразделение недоступно."},{status:403});
    const saved=planId ? await readCommonPlan(ctx.database,ctx.user.id,date,planId) : null;
    if(saved?.outdated) return NextResponse.json({message:"Общий план устарел. Пересчитайте его перед отчётом."},{status:409});
    const report:EquipmentReport={serviceDate:date,planId,requestCount:0,missingEquipmentOrderIds:[],missingEquipmentOrderNumbers:[],groups:[]};
    for(const department of departments.filter(d=>!filter || d.id===filter)) {
      const childId=saved?.result?.departments?.find(d=>d.id===department.id)?.planId;
      const url=new URL(request.url);url.searchParams.delete("planId");if(childId)url.searchParams.set("planId",childId);
      const headers=new Headers(request.headers);headers.set("X-MMI-Organization",department.id);
      const response=await readEquipment(new Request(url,{headers}));if(!response.ok)return response;
      const data=await response.json() as {report:EquipmentReport};
      report.requestCount+=data.report.requestCount;report.missingEquipmentOrderIds.push(...data.report.missingEquipmentOrderIds);
      report.missingEquipmentOrderNumbers!.push(...data.report.missingEquipmentOrderNumbers ?? data.report.missingEquipmentOrderIds);
      report.groups.push(...data.report.groups.map(group=>({...group,organizationId:department.id,departmentName:department.name})));
    }
    return NextResponse.json({report});
  } catch(error) {const known=planningErrorResponse(error);return known?NextResponse.json({message:known.message},{status:known.status}):serverError(error);}
}
