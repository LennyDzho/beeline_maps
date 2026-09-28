import { DEFAULT_OPTIMIZER_POLICY, DEFAULT_PLANNING_SETTINGS, isOptimizerPolicy, isOptimizationEngineId, isTravelMatrixProviderId, type PlanningSettings } from "../../planning-settings";
import { DEFAULT_CALCULATION_TIMEOUT_SECONDS, isCalculationTimeoutSeconds } from "../../planning-settings";

export async function loadPlanningSettings(database: D1Database): Promise<PlanningSettings> {
  const row = await database.prepare(`SELECT
    optimization_engine, solver_policy, travel_matrix_provider, calculation_timeout_seconds FROM system_settings WHERE id=1`)
    .first<{ optimization_engine: string; travel_matrix_provider: string; solver_policy: string | null; calculation_timeout_seconds: number }>();
  return {
    calculationTimeoutSeconds: isCalculationTimeoutSeconds(row?.calculation_timeout_seconds) ? row.calculation_timeout_seconds : DEFAULT_CALCULATION_TIMEOUT_SECONDS,
    optimizationEngine: isOptimizationEngineId(row?.optimization_engine) ? row.optimization_engine : DEFAULT_PLANNING_SETTINGS.optimizationEngine,
    travelMatrixProvider: isTravelMatrixProviderId(row?.travel_matrix_provider) ? row.travel_matrix_provider : DEFAULT_PLANNING_SETTINGS.travelMatrixProvider,
    optimizerPolicy: isOptimizerPolicy(row?.solver_policy) ? row.solver_policy : DEFAULT_OPTIMIZER_POLICY,
  };
}
