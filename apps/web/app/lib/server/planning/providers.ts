import { ProviderError, type OptimizationEnginePort, type RouteGeometryPort, type TravelTimeMatrixPort } from "@mmi/provider-contracts";
import { isPlanningCombinationSupported, OSRM_TRAVEL_WARNING, type PlanningSettings } from "../../planning-settings.js";
import { OsrmAdapter, type OsrmConfig } from "./osrm.js";
import { TwoGisMatrixAdapter } from "./two-gis-matrix.js";
import { TwoGisRoutingAdapter } from "./two-gis-routing.js";
import { TwoGisOptimizationEngine } from "./two-gis-optimizer.js";
import { OrToolsOptimizationEngine } from "./ortools-optimizer.js";
import { PyVrpOptimizationEngine } from "./pyvrp-optimizer.js";
import type { OptimizerServiceConfig } from "./service-optimizer.js";

export function selectRouteGeometryProvider(provider: PlanningSettings["travelMatrixProvider"], apiKey: string, config: OsrmConfig = {}): RouteGeometryPort {
  return provider === "osrm" ? new OsrmAdapter(config) : new TwoGisRoutingAdapter(apiKey);
}

export function selectPlanningProviders(settings: PlanningSettings, apiKey: string, osrmConfig: OsrmConfig = {}, optimizerConfig: OptimizerServiceConfig = {}): {
  matrix: TravelTimeMatrixPort; routing: RouteGeometryPort; optimizer: OptimizationEnginePort; warnings: string[];
} {
  if (!isPlanningCombinationSupported(settings.optimizationEngine, settings.travelMatrixProvider)) {
    throw new ProviderError({ code: "NOT_SUPPORTED", providerId: "2gis-tsp", message: "Для оптимизатора 2ГИС выберите источник расстояний 2ГИС. С OSRM работают PyVRP и OR-Tools.", retryable: false });
  }
  if (!["pyvrp", "ortools", "two_gis_tsp"].includes(settings.optimizationEngine)) {
    throw new ProviderError({code:"NOT_SUPPORTED",providerId:"optimizer",message:"Выбран неподдерживаемый метод оптимизации. Выберите PyVRP, OR-Tools или 2ГИС.",retryable:false});
  }
  const osrm = settings.travelMatrixProvider === "osrm" ? new OsrmAdapter(osrmConfig) : undefined;
  const matrix = osrm ?? new TwoGisMatrixAdapter(apiKey);
  const routing = osrm ?? new TwoGisRoutingAdapter(apiKey);
  return { matrix, routing,
    optimizer: settings.optimizationEngine === "pyvrp" ? new PyVrpOptimizationEngine(matrix, { ...optimizerConfig, policy: settings.optimizerPolicy }) : settings.optimizationEngine === "ortools" ? new OrToolsOptimizationEngine(matrix, { ...optimizerConfig, policy: settings.optimizerPolicy }) : new TwoGisOptimizationEngine(apiKey, matrix),
    warnings: osrm ? [OSRM_TRAVEL_WARNING] : [],
  };
}
