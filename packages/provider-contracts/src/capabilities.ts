import type { TravelMode, TrafficPolicy } from "./mobility.js";

export interface GeocodingCapabilities {
  readonly forward: boolean;
  readonly reverse: boolean;
  readonly addressSuggestions: boolean;
}

export interface MatrixCapabilities {
  readonly synchronous: boolean;
  readonly asynchronous: boolean;
  readonly asynchronousRequiresActivation?: boolean;
  readonly maxSynchronousElements?: number;
  readonly travelModes: ReadonlyArray<TravelMode>;
  readonly trafficPolicies: ReadonlyArray<TrafficPolicy>;
}

export interface RoutingCapabilities {
  readonly alternatives: boolean;
  readonly intermediateStops: boolean;
  readonly truckParameters: boolean;
  readonly avoidZones: boolean;
  readonly travelModes: ReadonlyArray<TravelMode>;
}

export interface MapCapabilities {
  readonly markers: boolean;
  readonly polylines: boolean;
  readonly geoJson: boolean;
  readonly customStyles: boolean;
  readonly markerClustering: boolean;
}

export interface OptimizationCapabilities {
  readonly maxJobs?: number;
  readonly maxAgents?: number;
  readonly multipleAgents: boolean;
  readonly hardTimeWindows: boolean;
  readonly softTimeWindows: boolean;
  readonly customSoftWindowPenalties: boolean;
  readonly serviceDuration: boolean;
  readonly skills: boolean;
  readonly fixedAgentResources: boolean;
  readonly sharedResources: boolean;
  readonly initialSolution: boolean;
  readonly lockedVisits: boolean;
}

export interface ProviderCapabilities {
  readonly providerId: string;
  readonly displayName: string;
  readonly geocoding?: GeocodingCapabilities;
  readonly matrix?: MatrixCapabilities;
  readonly routing?: RoutingCapabilities;
  readonly map?: MapCapabilities;
  readonly optimization?: OptimizationCapabilities;
}
