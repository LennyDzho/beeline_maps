import type { ProviderCapabilities } from "../capabilities.js";

/**
 * Capability declaration for the public 2GIS APIs evaluated for the MVP.
 * It contains no SDK types and can be replaced at the composition root.
 */
export const TWO_GIS_CAPABILITIES = {
  providerId: "2gis",
  displayName: "2ГИС",
  geocoding: {
    forward: true,
    reverse: true,
    addressSuggestions: true,
  },
  matrix: {
    synchronous: true,
    asynchronous: true,
    asynchronousRequiresActivation: true,
    maxSynchronousElements: 625,
    travelModes: ["driving", "truck", "walking", "public_transport", "cycling", "scooter"],
    trafficPolicies: ["provider_default", "live", "forecast", "historical"],
  },
  routing: {
    alternatives: true,
    intermediateStops: true,
    truckParameters: true,
    avoidZones: true,
    travelModes: ["driving", "truck", "walking", "public_transport", "cycling", "scooter"],
  },
  map: {
    markers: true,
    polylines: true,
    geoJson: true,
    customStyles: true,
    markerClustering: true,
  },
  optimization: {
    maxJobs: 4_000,
    maxAgents: 200,
    multipleAgents: true,
    hardTimeWindows: true,
    softTimeWindows: true,
    customSoftWindowPenalties: false,
    serviceDuration: true,
    skills: true,
    fixedAgentResources: true,
    sharedResources: false,
    initialSolution: true,
    lockedVisits: false,
  },
} as const satisfies ProviderCapabilities;
