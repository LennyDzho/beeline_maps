export type TravelMode =
  | "driving"
  | "truck"
  | "walking"
  | "public_transport"
  | "cycling"
  | "scooter";

export type TrafficPolicy =
  | "provider_default"
  | "live"
  | "forecast"
  | "historical"
  | "disabled";

export interface VehicleParameters {
  readonly weightKg?: number;
  readonly axleWeightKg?: number;
  readonly heightM?: number;
  readonly widthM?: number;
  readonly lengthM?: number;
  readonly payloadKg?: number;
  readonly ecoClass?: number;
  readonly hasTrailer?: boolean;
  /** Provider-neutral domain tags such as `permit:msk-mkad`. */
  readonly permits?: ReadonlyArray<string>;
}

export interface RouteAvoidance {
  readonly tolls?: boolean;
  readonly unpavedRoads?: boolean;
  readonly poorConditionRoads?: boolean;
  readonly ferries?: boolean;
  readonly zones?: ReadonlyArray<ReadonlyArray<import("./common.js").GeoPoint>>;
}

export interface TravelProfile {
  readonly mode: TravelMode;
  readonly traffic?: TrafficPolicy;
  readonly vehicle?: VehicleParameters;
  readonly avoid?: RouteAvoidance;
}
