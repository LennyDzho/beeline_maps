import {
  ProviderError,
  assertGeoPoint,
  type IdentifiedPoint,
  type MatrixCell,
  type ProviderRequestOptions,
  type ProviderResult,
  type TrafficPolicy,
  type TravelMode,
  type TravelTimeMatrix,
  type TravelTimeMatrixPort,
  type TravelTimeMatrixRequest,
} from "@mmi/provider-contracts";
import { fetchTwoGis } from "./two-gis-fetch.js";

const PROVIDER_ID = "2gis";
// This subscription permits 10 sources × 10 targets, below the API-wide 25 × 25 ceiling.
const MAX_SYNC_POINTS_PER_SIDE = 10;
const PUBLIC_TRANSPORT_TYPES = ["metro", "mcc", "mcd", "suburban_train", "tram", "bus", "trolleybus", "shuttle_bus"];

type TwoGisRoute = {
  status?: unknown;
  source_id?: unknown;
  target_id?: unknown;
  distance?: unknown;
  duration?: unknown;
};

type TwoGisMatrixResponse = {
  routes?: unknown;
};

/** 2GIS implementation of the provider-neutral matrix port. */
export class TwoGisMatrixAdapter implements TravelTimeMatrixPort {
  readonly providerId = PROVIDER_ID;

  constructor(private readonly apiKey: string, private readonly fetcher: typeof fetch = fetch) {
    if (!apiKey.trim()) {
      throw new ProviderError({
        code: "AUTHENTICATION",
        providerId: PROVIDER_ID,
        message: "Для матрицы маршрутов не настроен TWO_GIS_API_KEY.",
        retryable: false,
      });
    }
  }

  async calculate(
    request: TravelTimeMatrixRequest,
    options: ProviderRequestOptions = {},
  ): Promise<ProviderResult<TravelTimeMatrix>> {
    validateRequest(request);
    const cells = new Map<string, Map<string, MatrixCell>>();

    for (const origins of chunks(request.origins, MAX_SYNC_POINTS_PER_SIDE)) {
      for (const destinations of chunks(request.destinations, MAX_SYNC_POINTS_PER_SIDE)) {
        for (const cell of await this.calculateBlock(origins, destinations, request, options)) {
          const row = cells.get(cell.originId) ?? new Map<string, MatrixCell>();
          row.set(cell.destinationId, cell);
          cells.set(cell.originId, row);
        }
      }
    }

    return {
      data: {
        originIds: request.origins.map((item) => item.id),
        destinationIds: request.destinations.map((item) => item.id),
        cells: request.origins.flatMap((origin) => request.destinations.map((destination) => cells.get(origin.id)!.get(destination.id)!)),
      },
      meta: {
        providerId: PROVIDER_ID,
        receivedAt: new Date().toISOString(),
        cache: "bypass",
      },
    };
  }

  private async calculateBlock(
    origins: ReadonlyArray<IdentifiedPoint>,
    destinations: ReadonlyArray<IdentifiedPoint>,
    request: TravelTimeMatrixRequest,
    options: ProviderRequestOptions,
  ): Promise<MatrixCell[]> {
    const points = mergePoints(origins, destinations);
    const indexById = new Map(points.map((item, index) => [item.id, index]));
    const endpoint = new URL("https://routing.api.2gis.com/get_dist_matrix");
    endpoint.searchParams.set("key", this.apiKey);
    endpoint.searchParams.set("version", "2.0");

    let response: Response;
    try {
      response = await fetchTwoGis(endpoint, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({
          points: points.map((item) => item.point),
          sources: origins.map((item) => indexById.get(item.id)),
          targets: destinations.map((item) => indexById.get(item.id)),
          transport: toTwoGisTransport(request.profile.mode),
          type: toTwoGisRouteType(request.profile.traffic),
          ...(request.profile.mode === "public_transport" ? {
            public_transport_params: { transport: PUBLIC_TRANSPORT_TYPES, enable_schedule: true },
          } : {}),
          ...(request.departureAt ? { start_time: request.departureAt } : {}),
        }),
        cache: "no-store",
      }, { signal: options.signal, timeoutMs: options.timeoutMs ?? 9_000, attempts: 3 }, this.fetcher);
    } catch (cause) {
      if (options.signal?.aborted) {
        throw new ProviderError({ code: "CANCELLED", providerId: PROVIDER_ID, message: "Расчёт матрицы 2ГИС отменён.", retryable: false });
      }
      if (isAbort(cause)) {
        throw new ProviderError({ code: "TIMEOUT", providerId: PROVIDER_ID, message: "2ГИС не успел рассчитать матрицу маршрутов.", retryable: true, cause });
      }
      throw new ProviderError({ code: "UNAVAILABLE", providerId: PROVIDER_ID, message: "Матрица маршрутов 2ГИС временно недоступна.", retryable: true, cause });
    }

    if (!response.ok) {
      throw providerHttpError(response.status, await response.json().catch(() => undefined));
    }

    let payload: TwoGisMatrixResponse;
    try {
      payload = await response.json() as TwoGisMatrixResponse;
    } catch (cause) {
      throw new ProviderError({ code: "BAD_RESPONSE", providerId: PROVIDER_ID, message: "2ГИС вернул некорректную матрицу маршрутов.", retryable: true, cause });
    }

    const rawRoutes = Array.isArray(payload.routes) ? payload.routes : [];
    const routeByPair = new Map<string, TwoGisRoute>();
    for (const value of rawRoutes) {
      if (!value || typeof value !== "object") continue;
      const route = value as TwoGisRoute;
      if (Number.isInteger(route.source_id) && Number.isInteger(route.target_id)) {
        routeByPair.set(`${route.source_id}:${route.target_id}`, route);
      }
    }

    return origins.flatMap((origin) => destinations.map((destination): MatrixCell => {
      if (origin.id === destination.id) {
        return { status: "ok", originId: origin.id, destinationId: destination.id, durationSeconds: 0, distanceMeters: 0 };
      }
      const sourceIndex = indexById.get(origin.id)!;
      const targetIndex = indexById.get(destination.id)!;
      const route = routeByPair.get(`${sourceIndex}:${targetIndex}`);
      if (route?.status === "OK" && isNonNegativeNumber(route.duration) && isNonNegativeNumber(route.distance)) {
        return {
          status: "ok",
          originId: origin.id,
          destinationId: destination.id,
          durationSeconds: Math.round(route.duration),
          distanceMeters: Math.round(route.distance),
        };
      }
      const providerStatus = typeof route?.status === "string" ? route.status : "MISSING_RESULT";
      return {
        status: isNoRouteStatus(providerStatus) ? "no_route" : "unavailable",
        originId: origin.id,
        destinationId: destination.id,
        reason: providerStatus,
      };
    }));
  }
}

function validateRequest(request: TravelTimeMatrixRequest): void {
  if (request.origins.length === 0 || request.destinations.length === 0) {
    throw new ProviderError({ code: "INVALID_REQUEST", providerId: PROVIDER_ID, message: "Матрице нужны точки отправления и назначения.", retryable: false });
  }
  for (const item of [...request.origins, ...request.destinations]) assertGeoPoint(item.point);
  ensureUniqueIds(request.origins, "отправления");
  ensureUniqueIds(request.destinations, "назначения");
  // Check all IDs before sending any block, including IDs shared by different blocks.
  mergePoints(request.origins, request.destinations);
}

function ensureUniqueIds(points: ReadonlyArray<IdentifiedPoint>, label: string): void {
  const ids = new Set<string>();
  for (const point of points) {
    if (!point.id || ids.has(point.id)) {
      throw new ProviderError({ code: "INVALID_REQUEST", providerId: PROVIDER_ID, message: `Идентификаторы точек ${label} должны быть непустыми и уникальными.`, retryable: false });
    }
    ids.add(point.id);
  }
}

function mergePoints(origins: ReadonlyArray<IdentifiedPoint>, destinations: ReadonlyArray<IdentifiedPoint>): IdentifiedPoint[] {
  const result = new Map<string, IdentifiedPoint>();
  for (const point of [...origins, ...destinations]) {
    const existing = result.get(point.id);
    if (existing && (existing.point.lat !== point.point.lat || existing.point.lon !== point.point.lon)) {
      throw new ProviderError({ code: "INVALID_REQUEST", providerId: PROVIDER_ID, message: `Точка ${point.id} имеет разные координаты.`, retryable: false });
    }
    result.set(point.id, point);
  }
  return [...result.values()];
}

function toTwoGisTransport(mode: TravelMode): string {
  if (mode === "cycling") return "bicycle";
  return mode;
}

function toTwoGisRouteType(traffic: TrafficPolicy | undefined): "jam" | "statistics" | "shortest" {
  if (traffic === "disabled") return "shortest";
  if (traffic === "forecast" || traffic === "historical") return "statistics";
  return "jam";
}

function providerHttpError(status: number, payload: unknown): ProviderError {
  const message = payload && typeof payload === "object" && "error_message" in payload ? payload.error_message : undefined;
  if ([400, 403, 422].includes(status) && typeof message === "string" && /permissible dimension of the matrix is exceeded/i.test(message)) {
    const dimensions = message.match(/\(src\s*x\s*trg\):\s*(\d{1,6})\s*x\s*(\d{1,6})\b/i);
    const limit = dimensions ? ` Лимит ключа: ${Number(dimensions[1])} × ${Number(dimensions[2])} (отправления × назначения).` : "";
    // Never expose the raw provider body: it may contain the URL and API key.
    return new ProviderError({ code: "INVALID_REQUEST", providerId: PROVIDER_ID, message: `Превышен допустимый размер матрицы 2ГИС.${limit} Требуется уменьшить размер блоков запроса.`, retryable: false, httpStatus: status });
  }
  if (status === 401 || status === 403) return new ProviderError({ code: status === 401 ? "AUTHENTICATION" : "FORBIDDEN", providerId: PROVIDER_ID, message: "2ГИС отклонил ключ или доступ к Distance Matrix API.", retryable: false, httpStatus: status });
  if (status === 408) return new ProviderError({ code: "TIMEOUT", providerId: PROVIDER_ID, message: "2ГИС не успел рассчитать матрицу маршрутов.", retryable: true, httpStatus: status });
  if (status === 429) return new ProviderError({ code: "RATE_LIMITED", providerId: PROVIDER_ID, message: "Превышен лимит запросов к матрице 2ГИС.", retryable: true, httpStatus: status });
  if (status === 400 || status === 422) return new ProviderError({ code: "INVALID_REQUEST", providerId: PROVIDER_ID, message: "2ГИС отклонил параметры матрицы маршрутов.", retryable: false, httpStatus: status });
  return new ProviderError({ code: "UNAVAILABLE", providerId: PROVIDER_ID, message: "2ГИС временно не может рассчитать матрицу маршрутов.", retryable: status >= 500, httpStatus: status });
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && (error.name === "AbortError" || error.name === "TimeoutError");
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isNoRouteStatus(status: string): boolean {
  return status === "ROUTE_NOT_FOUND" || status === "ROUTE_DOES_NOT_EXISTS" || status === "ATTRACT_FAIL" || status === "PLATFORMS_NOT_FOUND";
}

function chunks<T>(items: ReadonlyArray<T>, size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size));
  return result;
}
