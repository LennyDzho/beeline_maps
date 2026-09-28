import type { TravelProfile } from "@mmi/provider-contracts";
import type { PlanningSettings } from "../../planning-settings.js";

export type WorkerTransportMode = "car" | "transit";

// Resources are the source of truth, including assignments made outside the worker editor.
export const WORKER_TRANSPORT_SQL = `CASE WHEN EXISTS (
  SELECT 1 FROM resources WHERE assigned_worker_id = workers.id
    AND organization_id = workers.organization_id AND type IN ('Фургон','Легковой')
) THEN 'car' ELSE 'transit' END`;
export const WORKER_PLATE_SQL = `COALESCE((SELECT plate FROM resources
  WHERE assigned_worker_id = workers.id AND organization_id = workers.organization_id
    AND type IN ('Фургон','Легковой') ORDER BY id LIMIT 1), '')`;

export function isWorkerTransportSupported(mode: WorkerTransportMode, settings: PlanningSettings): boolean {
  // This restriction belongs to the TSP engine, not the OSRM distance provider.
  return !(settings.optimizationEngine === "two_gis_tsp" && mode === "transit");
}

export function workerTravelProfile(mode: WorkerTransportMode, settings: PlanningSettings): TravelProfile {
  if (settings.travelMatrixProvider === "osrm") {
    // Public transport is approximated by the driving road graph, without transit schedules.
    // Matrix, optimizer/validator and route geometry all use this same profile.
    return { mode: "driving", traffic: "disabled" };
  }
  if (mode === "car") return { mode: "driving", traffic: "forecast" };
  return { mode: "public_transport", traffic: "forecast" };
}
