import { NextResponse } from "next/server";
import { badRequest, isApiError, requireApiContext, serverError } from "@/app/api/_shared";
import { loadCompletionReport, ReportPeriodError } from "@/app/lib/server/reports";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const context = await requireApiContext(request, "reports.view");
    if (isApiError(context)) return context;
    const report = await loadCompletionReport(context.database, context.organizationId, new URL(request.url).searchParams);
    return NextResponse.json(report, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return error instanceof ReportPeriodError ? badRequest(error.message) : serverError(error);
  }
}
