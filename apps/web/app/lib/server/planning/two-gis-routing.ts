import {
  ProviderError,
  assertGeoPoint,
  type GeoPoint,
  type ProviderRequestOptions,
  type ProviderResult,
  type RouteAlternative,
  type RouteGeometryPort,
  type RouteRequest,
  type TravelMode,
} from "@mmi/provider-contracts";
import { fetchTwoGis } from "./two-gis-fetch.js";

const PROVIDER_ID = "2gis";
const MAX_REGULAR_STOPS = 10;
const MAX_PUBLIC_TRANSPORT_STOPS = 12;

type JsonObject = Record<string, unknown>;

/** 2GIS Routing API adapter. Provider WKT never leaks past this boundary. */
export class TwoGisRoutingAdapter implements RouteGeometryPort {
  readonly providerId = PROVIDER_ID;

  constructor(private readonly apiKey: string) {
    if (!apiKey.trim()) throw providerError("AUTHENTICATION", "Для геометрии маршрутов не настроен TWO_GIS_API_KEY.", false);
  }

  async buildRoute(request: RouteRequest, options: ProviderRequestOptions = {}): Promise<ProviderResult<ReadonlyArray<RouteAlternative>>> {
    if (request.stops.length < 2) throw providerError("INVALID_REQUEST", "Для маршрута нужны минимум две точки.", false);
    for (const stop of request.stops) assertGeoPoint(stop.point);

    const limit = request.profile.mode === "public_transport"
      ? MAX_PUBLIC_TRANSPORT_STOPS
      : request.profile.mode === "walking" ? 5 : MAX_REGULAR_STOPS;
    const chunks = overlappingChunks(request.stops, limit);
    const parts: Array<{ geometry: GeoPoint[]; durationSeconds: number; distanceMeters: number; fromId: string; toId: string }> = [];
    for (const stops of chunks) parts.push(await this.buildPart(stops, request, options));

    const geometry = mergeGeometries(parts.map((part) => part.geometry));
    const durationSeconds = parts.reduce((sum, part) => sum + part.durationSeconds, 0);
    const distanceMeters = parts.reduce((sum, part) => sum + part.distanceMeters, 0);
    const alternative: RouteAlternative = {
      id: `2gis:${request.stops.map((stop) => stop.id).join(":")}`,
      durationSeconds,
      distanceMeters,
      geometry,
      legs: parts.map((part) => ({
        fromStopId: part.fromId,
        toStopId: part.toId,
        durationSeconds: part.durationSeconds,
        distanceMeters: part.distanceMeters,
        geometry: part.geometry,
      })),
    };
    return {
      data: [alternative],
      meta: { providerId: PROVIDER_ID, receivedAt: new Date().toISOString(), cache: "bypass" },
    };
  }

  private async buildPart(
    stops: RouteRequest["stops"],
    request: RouteRequest,
    options: ProviderRequestOptions,
  ) {
    return request.profile.mode === "public_transport"
      ? this.buildPublicTransportPart(stops, request, options)
      : this.buildRegularPart(stops, request, options);
  }

  private async buildRegularPart(
    stops: RouteRequest["stops"],
    request: RouteRequest,
    options: ProviderRequestOptions,
  ) {
    const endpoint = routeEndpoint("routing/7.0.0/global", this.apiKey);
    const payload = await postJson(endpoint, {
      points: stops.map((stop, index) => ({
        type: index === 0 || index === stops.length - 1
          ? request.profile.mode === "walking" ? "walking" : "stop"
          : "pref",
        lon: stop.point.lon,
        lat: stop.point.lat,
        ...(index === 0 ? { start: true } : {}),
      })),
      transport: toTwoGisTransport(request.profile.mode),
      output: "detailed",
      locale: "ru",
      route_mode: request.profile.traffic === "disabled" ? "shortest" : "fastest",
      traffic_mode: request.profile.traffic === "forecast" || request.profile.traffic === "historical" ? "statistics" : "jam",
      ...(request.departureAt ? { utc: Math.floor(Date.parse(request.departureAt) / 1_000) } : {}),
      alternative: Math.max(0, Math.min(3, (request.alternatives ?? 1) - 1)),
    }, options);
    const root = asObject(payload);
    const variants = Array.isArray(root?.result) ? root.result : [];
    const variant = asObject(variants[0]);
    if (!root || root.status !== "OK" || !variant) throw providerError("NO_ROUTE", providerMessage(root, "2ГИС не построил маршрут."), false);
    const geometry = extractRegularGeometry(variant);
    if (geometry.length < 2) throw providerError("BAD_RESPONSE", "2ГИС не вернул геометрию маршрута.", true);
    return {
      geometry,
      durationSeconds: nonNegativeNumber(variant.total_duration),
      distanceMeters: nonNegativeNumber(variant.total_distance),
      fromId: stops[0]!.id,
      toId: stops.at(-1)!.id,
    };
  }

  private async buildPublicTransportPart(
    stops: RouteRequest["stops"],
    request: RouteRequest,
    options: ProviderRequestOptions,
  ) {
    const endpoint = routeEndpoint("public_transport/2.0", this.apiKey);
    const toPoint = (stop: RouteRequest["stops"][number]) => ({ point: { lat: stop.point.lat, lon: stop.point.lon } });
    const payload = await postJson(endpoint, {
      source: toPoint(stops[0]!),
      target: toPoint(stops.at(-1)!),
      intermediate_points: stops.slice(1, -1).map(toPoint),
      transport: ["metro", "mcc", "mcd", "suburban_train", "tram", "bus", "trolleybus", "shuttle_bus"],
      locale: "ru",
      max_result_count: 1,
      enable_schedule: true,
      ...(request.departureAt ? { start_time: Math.floor(Date.parse(request.departureAt) / 1_000) } : {}),
    }, options);
    const variants = Array.isArray(payload) ? payload : [];
    const firstResult = Array.isArray(variants[0]) ? variants[0][0] : variants[0];
    const variant = asObject(firstResult);
    if (!variant) throw providerError("NO_ROUTE", "2ГИС не построил маршрут общественным транспортом.", false);
    const geometry = extractPublicTransportGeometry(variant);
    if (geometry.length < 2) throw providerError("BAD_RESPONSE", "2ГИС не вернул геометрию маршрута общественного транспорта.", true);
    return {
      geometry,
      durationSeconds: nonNegativeNumber(variant.total_duration),
      distanceMeters: nonNegativeNumber(variant.total_distance),
      fromId: stops[0]!.id,
      toId: stops.at(-1)!.id,
    };
  }
}

async function postJson(endpoint: URL, body: JsonObject, options: ProviderRequestOptions): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchTwoGis(endpoint, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
    }, { signal: options.signal, timeoutMs: options.timeoutMs ?? 12_000, attempts: 2 });
  } catch (cause) {
    if (isAbort(cause)) throw new ProviderError({ code: "TIMEOUT", providerId: PROVIDER_ID, message: "2ГИС не успел построить геометрию маршрута.", retryable: true, cause });
    throw new ProviderError({ code: "UNAVAILABLE", providerId: PROVIDER_ID, message: "Routing API 2ГИС временно недоступен.", retryable: true, cause });
  }
  if (!response.ok) throw httpError(response.status);
  try {
    return await response.json();
  } catch (cause) {
    throw new ProviderError({ code: "BAD_RESPONSE", providerId: PROVIDER_ID, message: "2ГИС вернул некорректную геометрию маршрута.", retryable: true, cause });
  }
}

function extractRegularGeometry(root: JsonObject): GeoPoint[] {
  const selections: string[] = [];
  collectSelections(root.begin_pedestrian_path, selections);
  const maneuvers = Array.isArray(root.maneuvers) ? root.maneuvers : [];
  for (const maneuver of maneuvers) collectSelections(asObject(maneuver)?.outcoming_path, selections);
  collectSelections(root.end_pedestrian_path, selections);
  return mergeGeometries(selections.map(parseLineString));
}

function extractPublicTransportGeometry(root: JsonObject): GeoPoint[] {
  const selections: string[] = [];
  const movements = Array.isArray(root.movements) ? root.movements : [];
  for (const movement of movements) {
    const alternatives = asObject(movement)?.alternatives;
    const alternative = Array.isArray(alternatives) ? alternatives[0] : alternatives;
    collectSelections(asObject(alternative)?.geometry, selections);
  }
  return mergeGeometries(selections.map(parseLineString));
}

function collectSelections(value: unknown, selections: string[]): void {
  if (Array.isArray(value)) {
    for (const item of value) collectSelections(item, selections);
    return;
  }
  const object = asObject(value);
  if (!object) return;
  if (typeof object.selection === "string" && object.selection.startsWith("LINESTRING")) selections.push(object.selection);
  for (const [key, child] of Object.entries(object)) {
    if (key === "selection") continue;
    if (key === "alternatives" && Array.isArray(child)) collectSelections(child[0], selections);
    else collectSelections(child, selections);
  }
}

export function parseLineString(value: string): GeoPoint[] {
  const match = /^LINESTRING(?:\s+Z)?\s*\((.*)\)$/iu.exec(value.trim());
  if (!match) return [];
  return match[1]!.split(",").flatMap((pair) => {
    const [lonText, latText] = pair.trim().split(/\s+/u);
    const lon = Number(lonText);
    const lat = Number(latText);
    return Number.isFinite(lat) && Number.isFinite(lon) && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180 ? [{ lat, lon }] : [];
  });
}

function mergeGeometries(parts: ReadonlyArray<ReadonlyArray<GeoPoint>>): GeoPoint[] {
  const result: GeoPoint[] = [];
  for (const part of parts) {
    for (const point of part) {
      const previous = result.at(-1);
      if (!previous || previous.lat !== point.lat || previous.lon !== point.lon) result.push(point);
    }
  }
  return result;
}

function overlappingChunks<T>(items: ReadonlyArray<T>, limit: number): T[][] {
  if (items.length <= limit) return [[...items]];
  const result: T[][] = [];
  let index = 0;
  while (index < items.length - 1) {
    const chunk = items.slice(index, index + limit);
    result.push(chunk);
    index += chunk.length - 1;
  }
  return result;
}

function routeEndpoint(path: string, apiKey: string): URL {
  const endpoint = new URL(`https://routing.api.2gis.com/${path}`);
  endpoint.searchParams.set("key", apiKey);
  return endpoint;
}

function toTwoGisTransport(mode: TravelMode): string {
  return mode === "cycling" ? "bicycle" : mode;
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && (error.name === "AbortError" || error.name === "TimeoutError");
}

function httpError(status: number): ProviderError {
  if (status === 401 || status === 403) return new ProviderError({ code: status === 401 ? "AUTHENTICATION" : "FORBIDDEN", providerId: PROVIDER_ID, message: "2ГИС отклонил ключ или доступ к Routing API.", retryable: false, httpStatus: status });
  if (status === 408) return new ProviderError({ code: "TIMEOUT", providerId: PROVIDER_ID, message: "2ГИС не успел построить маршрут.", retryable: true, httpStatus: status });
  if (status === 429) return new ProviderError({ code: "RATE_LIMITED", providerId: PROVIDER_ID, message: "Превышен лимит запросов к Routing API 2ГИС.", retryable: true, httpStatus: status });
  if (status === 400 || status === 422) return new ProviderError({ code: "INVALID_REQUEST", providerId: PROVIDER_ID, message: "2ГИС отклонил параметры маршрута.", retryable: false, httpStatus: status });
  return new ProviderError({ code: "UNAVAILABLE", providerId: PROVIDER_ID, message: "Routing API 2ГИС временно недоступен.", retryable: status >= 500, httpStatus: status });
}

function providerError(code: "AUTHENTICATION" | "INVALID_REQUEST" | "NO_ROUTE" | "BAD_RESPONSE", message: string, retryable: boolean) {
  return new ProviderError({ code, providerId: PROVIDER_ID, message, retryable });
}

function providerMessage(value: JsonObject | undefined, fallback: string): string {
  return typeof value?.message === "string" && value.message.trim() ? value.message : fallback;
}

function nonNegativeNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : 0;
}

function asObject(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined;
}
