import { NextResponse } from "next/server";
import { badRequest, isApiError, readJsonObject, requireApiContext, serverError } from "@/app/api/_shared";
import { DEFAULT_OPTIMIZER_POLICY, isOptimizerPolicy, isOptimizationEngineId, isTravelMatrixProviderId, isPlanningCombinationSupported } from "@/app/lib/planning-settings";
import { isRegionalTimezone } from "@/app/lib/regional-time";
import { GeocodingError, geocodeAddress } from "@/app/lib/server/geocoding";
import { DEFAULT_CALCULATION_TIMEOUT_SECONDS, isCalculationTimeoutSeconds } from "@/app/lib/planning-settings";

export async function PUT(request: Request) {
  try {
    const context = await requireApiContext(request, "admin.settings");
    if (isApiError(context)) return context;
    const body = await readJsonObject(request);
    if (!body || (body.scope !== undefined && body.scope !== "department" && body.scope !== "planning")) return badRequest();
    // Requests without a scope retain compatibility with older clients.
    const saveDepartment = body.scope !== "planning";
    const savePlanning = body.scope !== "department";
    if (saveDepartment && !isRegionalTimezone(body.timezone)) return badRequest();
    if (saveDepartment && body.officeAddress !== undefined && (typeof body.officeAddress !== "string" || body.officeAddress.length > 500)) return badRequest();
    if (savePlanning) {
      if (body.calculationTimeoutSeconds !== undefined && !isCalculationTimeoutSeconds(body.calculationTimeoutSeconds)) return badRequest("Время расчёта должно быть целым числом от 30 до 1800 секунд.");
      if (!isOptimizationEngineId(body.optimizationEngine) || !isTravelMatrixProviderId(body.travelMatrixProvider)) return badRequest();
      if (body.optimizerPolicy !== undefined && !isOptimizerPolicy(body.optimizerPolicy)) return badRequest("Неизвестная политика планирования аварий.");
      if (!isPlanningCombinationSupported(body.optimizationEngine, body.travelMatrixProvider)) return badRequest("TSP API 2ГИС использует матрицу 2ГИС. Для OSRM выберите PyVRP или OR-Tools.");
    }
    const now = new Date().toISOString();
    const existing = await context.database.prepare("SELECT timezone, office_address, office_latitude, office_longitude FROM organizations WHERE id = ?")
      .bind(context.organizationId).first<{ timezone: string; office_address: string; office_latitude: number | null; office_longitude: number | null }>();
    const previousPolicy = await context.database.prepare("SELECT solver_policy,calculation_timeout_seconds FROM system_settings WHERE id=1").first<{solver_policy:string;calculation_timeout_seconds:number}>();
    const calculationTimeoutSeconds = body.calculationTimeoutSeconds ?? previousPolicy?.calculation_timeout_seconds ?? DEFAULT_CALCULATION_TIMEOUT_SECONDS;
    const optimizerPolicy = isOptimizerPolicy(body.optimizerPolicy) ? body.optimizerPolicy : isOptimizerPolicy(previousPolicy?.solver_policy) ? previousPolicy.solver_policy : DEFAULT_OPTIMIZER_POLICY;
    const officeAddress = typeof body.officeAddress === "string" ? body.officeAddress.trim() : existing?.office_address ?? "";
    const point = !saveDepartment || !officeAddress ? null : officeAddress === existing?.office_address && existing.office_latitude !== null && existing.office_longitude !== null
      ? { lat: existing.office_latitude, lon: existing.office_longitude } : (await geocodeAddress(officeAddress)).point;
    await context.database.batch([
      // Freeze legacy appointment context before changing the department's default.
      ...saveDepartment && body.timezone !== existing!.timezone ? [context.database.prepare("UPDATE work_orders SET scheduling_timezone = ? WHERE organization_id = ? AND scheduling_timezone IS NULL")
        .bind(existing!.timezone, context.organizationId)] : [],
      ...saveDepartment ? [context.database.prepare(`UPDATE organizations SET timezone = ?, office_address = ?, office_latitude = ?, office_longitude = ?, updated_at = ? WHERE id = ?`).bind(
        body.timezone, officeAddress, point?.lat ?? null, point?.lon ?? null, now, context.organizationId,
      )] : [],
      ...savePlanning ? [context.database.prepare(`UPDATE system_settings SET optimization_engine=?,solver_policy=?,travel_matrix_provider=?,calculation_timeout_seconds=?,updated_at=? WHERE id=1`)
        .bind(body.optimizationEngine,optimizerPolicy,body.travelMatrixProvider,calculationTimeoutSeconds,now)] : [],
    ]);
    return NextResponse.json({ settings: {
      ...saveDepartment ? { timezone: body.timezone, officeAddress } : {},
      ...savePlanning ? { optimizationEngine: body.optimizationEngine, travelMatrixProvider: body.travelMatrixProvider, optimizerPolicy, calculationTimeoutSeconds } : {},
    } });
  } catch (error) {
    if (error instanceof GeocodingError) return NextResponse.json({ message: error.message }, { status: error.code === "NOT_FOUND" ? 400 : 503 });
    return serverError(error);
  }
}
