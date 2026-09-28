import type { ProviderCapabilities } from "../capabilities.js";
import {
  assertGeoPoint,
  ProviderError,
  type GeoBounds,
  type GeoPoint,
  type ProviderRequestOptions,
  type ProviderResponseMeta,
} from "../common.js";
import type {
  ForwardGeocodeRequest,
  GeocoderPort,
  GeocodingCandidate,
  ReverseGeocodeRequest,
} from "../geocoding.js";
import type {
  MapRendererEvent,
  MapRendererOptions,
  MapRendererPort,
  MapScene,
  Unsubscribe,
} from "../map-renderer.js";
import type {
  TravelTimeMatrix,
  TravelTimeMatrixPort,
  TravelTimeMatrixRequest,
} from "../matrix.js";
import type { TravelMode } from "../mobility.js";
import type {
  OptimizationEnginePort,
  PlanProposal,
  PlanningProblem,
} from "../optimization.js";
import type { ProviderBundle } from "../provider-bundle.js";
import type {
  RouteAlternative,
  RouteGeometryPort,
  RouteLeg,
  RouteRequest,
} from "../routing.js";

const FAKE_PROVIDER_ID = "fake";
const EARTH_RADIUS_M = 6_371_000;

function meta(): ProviderResponseMeta {
  return {
    providerId: FAKE_PROVIDER_ID,
    receivedAt: new Date().toISOString(),
    cache: "bypass",
  };
}

function ensureNotCancelled(options?: ProviderRequestOptions): void {
  if (options?.signal?.aborted === true) {
    throw new ProviderError({
      code: "CANCELLED",
      providerId: FAKE_PROVIDER_ID,
      message: "The operation was cancelled",
      retryable: false,
      cause: options.signal.reason,
    });
  }
}

function normalizeQuery(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase("ru-RU");
}

export function haversineDistanceMeters(a: GeoPoint, b: GeoPoint): number {
  assertGeoPoint(a);
  assertGeoPoint(b);

  const toRadians = (degrees: number): number => (degrees * Math.PI) / 180;
  const deltaLat = toRadians(b.lat - a.lat);
  const deltaLon = toRadians(b.lon - a.lon);
  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);
  const sinLat = Math.sin(deltaLat / 2);
  const sinLon = Math.sin(deltaLon / 2);
  const value = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLon * sinLon;

  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(value));
}

export interface GeocodingFixture {
  readonly query: string;
  readonly candidate: GeocodingCandidate;
}

export class InMemoryGeocoder implements GeocoderPort {
  readonly providerId = FAKE_PROVIDER_ID;

  constructor(private readonly fixtures: ReadonlyArray<GeocodingFixture>) {}

  async forward(request: ForwardGeocodeRequest, options?: ProviderRequestOptions) {
    ensureNotCancelled(options);
    const query = normalizeQuery(request.query);
    const limit = request.limit ?? 10;
    const candidates = this.fixtures
      .filter((fixture) => normalizeQuery(fixture.query).includes(query))
      .slice(0, limit)
      .map((fixture) => fixture.candidate);

    return { data: candidates, meta: meta() };
  }

  async reverse(request: ReverseGeocodeRequest, options?: ProviderRequestOptions) {
    ensureNotCancelled(options);
    assertGeoPoint(request.point);
    const limit = request.limit ?? 10;
    const candidates = [...this.fixtures]
      .sort(
        (left, right) =>
          haversineDistanceMeters(left.candidate.point, request.point) -
          haversineDistanceMeters(right.candidate.point, request.point),
      )
      .slice(0, limit)
      .map((fixture) => fixture.candidate);

    return { data: candidates, meta: meta() };
  }
}

const SPEED_METERS_PER_SECOND: Readonly<Record<TravelMode, number>> = {
  driving: 11.1,
  truck: 9.7,
  walking: 1.4,
  public_transport: 7,
  cycling: 4.5,
  scooter: 5.5,
};

/** Deterministic test matrix. It is not a road-routing implementation. */
export class HaversineMatrixProvider implements TravelTimeMatrixPort {
  readonly providerId = FAKE_PROVIDER_ID;

  async calculate(request: TravelTimeMatrixRequest, options?: ProviderRequestOptions) {
    ensureNotCancelled(options);
    const speed = SPEED_METERS_PER_SECOND[request.profile.mode];
    const cells: TravelTimeMatrix["cells"] = request.origins.flatMap((origin) =>
      request.destinations.map((destination) => {
        const distanceMeters = Math.round(
          haversineDistanceMeters(origin.point, destination.point),
        );

        return {
          status: "ok" as const,
          originId: origin.id,
          destinationId: destination.id,
          distanceMeters,
          durationSeconds: Math.round(distanceMeters / speed),
        };
      }),
    );

    return {
      data: {
        originIds: request.origins.map(({ id }) => id),
        destinationIds: request.destinations.map(({ id }) => id),
        cells,
      },
      meta: meta(),
    };
  }
}

/** Returns straight segments for offline UI and contract tests. */
export class StraightLineRouteProvider implements RouteGeometryPort {
  readonly providerId = FAKE_PROVIDER_ID;

  async buildRoute(request: RouteRequest, options?: ProviderRequestOptions) {
    ensureNotCancelled(options);
    if (request.stops.length < 2) {
      throw new ProviderError({
        code: "INVALID_REQUEST",
        providerId: this.providerId,
        message: "At least two route stops are required",
        retryable: false,
      });
    }

    const speed = SPEED_METERS_PER_SECOND[request.profile.mode];
    const legs: RouteLeg[] = [];

    for (let index = 1; index < request.stops.length; index += 1) {
      const from = request.stops[index - 1]!;
      const to = request.stops[index]!;
      const distanceMeters = Math.round(haversineDistanceMeters(from.point, to.point));
      legs.push({
        fromStopId: from.id,
        toStopId: to.id,
        durationSeconds: Math.round(distanceMeters / speed),
        distanceMeters,
        geometry: [from.point, to.point],
      });
    }

    const route: RouteAlternative = {
      id: "fake-route-0",
      durationSeconds: legs.reduce((total, leg) => total + leg.durationSeconds, 0),
      distanceMeters: legs.reduce((total, leg) => total + leg.distanceMeters, 0),
      geometry: request.stops.map(({ point }) => point),
      legs,
    };

    return { data: [route], meta: meta() };
  }
}

export class RecordingMapRenderer implements MapRendererPort {
  readonly providerId = FAKE_PROVIDER_ID;
  private listeners = new Set<(event: MapRendererEvent) => void>();
  private currentScene: MapScene | undefined;
  private mounted = false;

  get scene(): MapScene | undefined {
    return this.currentScene;
  }

  async mount(_target: Element, scene: MapScene, _options?: MapRendererOptions) {
    this.currentScene = scene;
    this.mounted = true;
  }

  async update(scene: MapScene) {
    if (!this.mounted) {
      throw new Error("Map renderer must be mounted before update");
    }
    this.currentScene = scene;
  }

  async fitBounds(_bounds: GeoBounds, _paddingPx?: number) {
    if (!this.mounted) {
      throw new Error("Map renderer must be mounted before fitBounds");
    }
  }

  subscribe(listener: (event: MapRendererEvent) => void): Unsubscribe {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: MapRendererEvent): void {
    this.listeners.forEach((listener) => listener(event));
  }

  async destroy() {
    this.listeners.clear();
    this.currentScene = undefined;
    this.mounted = false;
  }
}

export class StubOptimizationEngine implements OptimizationEnginePort {
  readonly engineId: string;

  constructor(
    handler: (problem: PlanningProblem, options?: ProviderRequestOptions) => Promise<PlanProposal>,
    engineId = "stub-optimizer",
  ) {
    this.handler = handler;
    this.engineId = engineId;
  }

  private readonly handler: (
    problem: PlanningProblem,
    options?: ProviderRequestOptions,
  ) => Promise<PlanProposal>;

  optimize(problem: PlanningProblem, options?: ProviderRequestOptions): Promise<PlanProposal> {
    return this.handler(problem, options);
  }
}

export const FAKE_PROVIDER_CAPABILITIES = {
  providerId: FAKE_PROVIDER_ID,
  displayName: "Deterministic fake provider",
  geocoding: { forward: true, reverse: true, addressSuggestions: false },
  matrix: {
    synchronous: true,
    asynchronous: false,
    travelModes: ["driving", "truck", "walking", "cycling", "scooter"],
    trafficPolicies: ["disabled"],
  },
  routing: {
    alternatives: false,
    intermediateStops: true,
    truckParameters: false,
    avoidZones: false,
    travelModes: ["driving", "truck", "walking", "cycling", "scooter"],
  },
  map: {
    markers: true,
    polylines: true,
    geoJson: false,
    customStyles: false,
    markerClustering: false,
  },
} as const satisfies ProviderCapabilities;

export function createFakeProviderBundle(
  geocodingFixtures: ReadonlyArray<GeocodingFixture> = [],
): ProviderBundle {
  return {
    providerId: FAKE_PROVIDER_ID,
    capabilities: FAKE_PROVIDER_CAPABILITIES,
    geocoder: new InMemoryGeocoder(geocodingFixtures),
    matrix: new HaversineMatrixProvider(),
    routeGeometry: new StraightLineRouteProvider(),
    mapRenderer: new RecordingMapRenderer(),
  };
}
