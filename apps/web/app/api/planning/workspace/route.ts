import { NextResponse } from "next/server";
import { isApiError,requireApiContext,serverError } from "@/app/api/_shared";
import { GET as readRequests } from "@/app/api/requests/route";
import { listPlanningDepartments } from "@/app/lib/server/planning/common-plan";
import type { RequestItem,RequestEngineer,RequestWorkType } from "@/app/requests/request-editor";
import type { WorkCategory } from "@/app/lib/work-catalog";
import { loadPlanningSettings } from "@/app/lib/server/planning/settings-storage";

export async function GET(request:Request) {
  try {
    const ctx=await requireApiContext(request); if(isApiError(ctx)) return ctx;
    const date = new URL(request.url).searchParams.get("date");
    if (date && (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T12:00:00Z`)))) return NextResponse.json({message:"Укажите корректную дату."},{status:400});
    const departments=await listPlanningDepartments(ctx.database,ctx.user.id);
    const planningSettings=await loadPlanningSettings(ctx.database);
    if(!departments.length) return NextResponse.json({message:"Нет доступных подразделений для планирования."},{status:403});
    const result={departments,planningSettings,items:[] as RequestItem[],engineers:[] as RequestEngineer[],workTypes:[] as RequestWorkType[],workCategories:[] as WorkCategory[]};
    for(const department of departments) {
      const headers=new Headers(request.headers); headers.set("X-MMI-Organization",department.id);
      // Reuse the ordinary request endpoint's permissions and performer visibility.
      const response=await readRequests(new Request(request.url,{headers}));
      if(!response.ok) return response;
      const data=await response.json() as typeof result;
      result.items.push(...data.items.filter(item => !date || item.dateTime.slice(0,10) === date).map(item=>({...item,organizationId:department.id})));
      result.engineers.push(...data.engineers.map(item=>({...item,organizationId:department.id})));
      if (!result.workTypes.length) result.workTypes = data.workTypes;
      if (!result.workCategories.length) result.workCategories = data.workCategories;
    }
    return NextResponse.json(result,{headers:{"Cache-Control":"no-store"}});
  } catch(error) {return serverError(error);}
}
