import type {
  DateTime,
  GeoPoint,
  IdentifiedPoint,
  ProviderRequestOptions,
  ProviderResult,
} from "./common.js";
import type { TravelProfile } from "./mobility.js";

export interface RouteStop extends IdentifiedPoint {
  readonly serviceDurationSeconds?: number;
}

export interface RouteRequest {
  readonly stops: ReadonlyArray<RouteStop>;
  readonly profile: TravelProfile;
  readonly departureAt?: DateTime;
  readonly alternatives?: number;
}

export interface RouteLeg {
  readonly fromStopId: string;
  readonly toStopId: string;
  readonly durationSeconds: number;
  readonly distanceMeters: number;
  readonly geometry: ReadonlyArray<GeoPoint>;
}

export interface RouteAlternative {
  readonly id: string;
  readonly durationSeconds: number;
  readonly distanceMeters: number;
  readonly geometry: ReadonlyArray<GeoPoint>;
  readonly legs: ReadonlyArray<RouteLeg>;
}

export interface RouteGeometryPort {
  readonly providerId: string;

  buildRoute(
    request: RouteRequest,
    options?: ProviderRequestOptions,
  ): Promise<ProviderResult<ReadonlyArray<RouteAlternative>>>;
}

