import {
  assertGeoPoint,
  type GeoPoint,
  type ProviderRequestOptions,
  type TravelMode,
  type TravelTimeMatrixPort,
  type TravelTimeMatrixRequest,
} from "@mmi/provider-contracts";

const EARTH_RADIUS_METERS = 6_371_000;
const SPEED_METERS_PER_SECOND: Readonly<Record<TravelMode, number>> = {
  driving: 9.7,
  truck: 8.3,
  walking: 1.35,
  public_transport: 6.2,
  cycling: 4.2,
  scooter: 5,
};

/** Offline estimate used only when a road matrix provider is unavailable. */
export class LocalEstimatedMatrixAdapter implements TravelTimeMatrixPort {
  readonly providerId = "local-estimated-matrix";

  async calculate(request: TravelTimeMatrixRequest, options: ProviderRequestOptions = {}) {
    if (options.signal?.aborted) throw options.signal.reason;
    const speed = SPEED_METERS_PER_SECOND[request.profile.mode];
    const cells = request.origins.flatMap((origin) => request.destinations.map((destination) => {
      assertGeoPoint(origin.point);
      assertGeoPoint(destination.point);
      const straightDistance = haversineDistance(origin.point, destination.point);
      const distanceMeters = origin.id === destination.id ? 0 : Math.round(straightDistance * 1.25);
      return { status: "ok" as const, originId: origin.id, destinationId: destination.id, distanceMeters, durationSeconds: Math.round(distanceMeters / speed) };
    }));
    return {
      data: { originIds: request.origins.map((point) => point.id), destinationIds: request.destinations.map((point) => point.id), cells },
      meta: { providerId: this.providerId, receivedAt: new Date().toISOString(), cache: "bypass" as const },
    };
  }
}

function haversineDistance(left: GeoPoint, right: GeoPoint) {
  const radians = (degrees: number) => degrees * Math.PI / 180;
  const deltaLat = radians(right.lat - left.lat);
  const deltaLon = radians(right.lon - left.lon);
  const value = Math.sin(deltaLat / 2) ** 2 + Math.cos(radians(left.lat)) * Math.cos(radians(right.lat)) * Math.sin(deltaLon / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.sqrt(value));
}
