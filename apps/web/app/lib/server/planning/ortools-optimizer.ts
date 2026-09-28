import type { TravelTimeMatrixPort } from "@mmi/provider-contracts";
import { ServiceOptimizationEngine, type OptimizerServiceConfig } from "./service-optimizer.js";
export { buildSolverInput, restoreRoutes, optimizerObjectives } from "./service-optimizer.js";
export type { OptimizerServiceConfig, SolverInput, SolverPolicy } from "./service-optimizer.js";

export class OrToolsOptimizationEngine extends ServiceOptimizationEngine {
  constructor(matrix: TravelTimeMatrixPort, config: OptimizerServiceConfig = {}, fetcher: typeof fetch = fetch) {
    super("ortools", "OR-Tools", matrix, config, fetcher);
  }
}
