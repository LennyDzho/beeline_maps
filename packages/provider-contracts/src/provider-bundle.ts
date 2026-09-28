import type { ProviderCapabilities } from "./capabilities.js";
import type { GeocoderPort } from "./geocoding.js";
import type { MapRendererPort } from "./map-renderer.js";
import type { TravelTimeMatrixPort } from "./matrix.js";
import type { OptimizationEnginePort } from "./optimization.js";
import type { RouteGeometryPort } from "./routing.js";

/** A composition root may provide any supported subset of services. */
export interface ProviderBundle {
  readonly providerId: string;
  readonly capabilities: ProviderCapabilities;
  readonly geocoder?: GeocoderPort;
  readonly matrix?: TravelTimeMatrixPort;
  readonly routeGeometry?: RouteGeometryPort;
  readonly mapRenderer?: MapRendererPort;
  readonly optimization?: OptimizationEnginePort;
}

export function assertProviderBundle(bundle: ProviderBundle): void {
  const { capabilities } = bundle;

  if (bundle.providerId !== capabilities.providerId) {
    throw new Error("Provider bundle id must match capabilities.providerId");
  }

  if (bundle.geocoder !== undefined && capabilities.geocoding === undefined) {
    throw new Error("Geocoder adapter is present but geocoding capabilities are missing");
  }

  if (bundle.matrix !== undefined && capabilities.matrix === undefined) {
    throw new Error("Matrix adapter is present but matrix capabilities are missing");
  }

  if (bundle.routeGeometry !== undefined && capabilities.routing === undefined) {
    throw new Error("Route adapter is present but routing capabilities are missing");
  }

  if (bundle.mapRenderer !== undefined && capabilities.map === undefined) {
    throw new Error("Map renderer is present but map capabilities are missing");
  }

  if (bundle.optimization !== undefined && capabilities.optimization === undefined) {
    throw new Error("Optimization adapter is present but optimization capabilities are missing");
  }
}

