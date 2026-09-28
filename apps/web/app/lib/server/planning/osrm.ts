import {
  ProviderError, assertGeoPoint,
  type GeoPoint, type IdentifiedPoint, type MatrixCell, type ProviderRequestOptions,
  type ProviderResult, type RouteAlternative, type RouteGeometryPort, type RouteLeg, type RouteRequest,
  type TravelProfile, type TravelTimeMatrix, type TravelTimeMatrixPort, type TravelTimeMatrixRequest,
} from "@mmi/provider-contracts";

export type OsrmConfig = { drivingUrl?: string | undefined; walkingUrl?: string | undefined; cyclingUrl?:string|undefined };
const DEMO_DRIVING = "https://router.project-osrm.org";
const DEMO_WALKING = "https://routing.openstreetmap.de/routed-foot";
const BLOCK_SIZE = 40; // At most 80 coordinates, below the standard 100-location Table limit.
let demoQueue: Promise<void> = Promise.resolve();
let lastDemoRequest = 0;

/** A profile URL must point at a server prepared with that actual OSRM profile. */
export class OsrmAdapter implements TravelTimeMatrixPort, RouteGeometryPort {
  readonly providerId = "osrm";
  // One adapter lives for one planning run. OSRM is static (no departure-time
  // traffic); reuse directed road cells by coordinates, including shared offices.
  private readonly roadCells = new Map<string, { duration: number | null; distance: number | null }>();
  constructor(private readonly config: OsrmConfig = {}, private readonly fetcher: typeof fetch = fetch) {}

  async calculate(request: TravelTimeMatrixRequest, options: ProviderRequestOptions = {}): Promise<ProviderResult<TravelTimeMatrix>> {
    this.baseUrl(request.profile);
    if (!request.origins.length || !request.destinations.length) throw failure("INVALID_REQUEST", "Матрице OSRM нужны точки отправления и назначения.");
    const merged = new Map<string, IdentifiedPoint>();
    for (const side of [request.origins, request.destinations]) {
      const ids = new Set<string>();
      for (const item of side) {
        assertGeoPoint(item.point);
        if (!item.id || ids.has(item.id)) throw failure("INVALID_REQUEST", "Идентификаторы точек должны быть уникальными.");
        ids.add(item.id);
        const previous = merged.get(item.id);
        if (previous && coordinates(previous.point) !== coordinates(item.point)) throw failure("INVALID_REQUEST", "Точка имеет разные координаты.");
        merged.set(item.id, item);
      }
    }
    if (isDemo(new URL(this.baseUrl(request.profile))) && merged.size > 100) throw failure("INVALID_REQUEST", "Для расчёта более 100 точек настройте собственный сервер OSRM. Публичный сервер предназначен для небольших тестов.");
    if (options.signal?.aborted) throw failure("CANCELLED", "Расчёт OSRM отменён.");
    const profileKey = this.endpoint("table", [], request.profile).href;
    const cellKey = (origin: IdentifiedPoint, destination: IdentifiedPoint) => `${profileKey}|${coordinates(origin.point)}|${coordinates(destination.point)}`;
    const uniqueOrigins = [...new Map(request.origins.map(item => [coordinates(item.point), item])).values()];
    const uniqueDestinations = [...new Map(request.destinations.map(item => [coordinates(item.point), item])).values()];
    const missingGroups = new Map<string, { origins: IdentifiedPoint[]; destinations: IdentifiedPoint[] }>();
    for (const origin of uniqueOrigins) {
      const destinations = uniqueDestinations.filter(destination => !this.roadCells.has(cellKey(origin, destination)));
      if (!destinations.length) continue;
      const key = destinations.map(item => coordinates(item.point)).join(";");
      const group = missingGroups.get(key) ?? { origins: [], destinations };
      group.origins.push(origin);
      missingGroups.set(key, group);
    }
    for (const group of missingGroups.values()) {
    for (let i = 0; i < group.origins.length; i += BLOCK_SIZE) {
      const origins = group.origins.slice(i, i + BLOCK_SIZE);
      for (let j = 0; j < group.destinations.length; j += BLOCK_SIZE) {
        const destinations = group.destinations.slice(j, j + BLOCK_SIZE);
        const points = [...new Map([...origins, ...destinations].map((item) => [coordinates(item.point), item])).values()];
        const index = new Map(points.map((item, k) => [coordinates(item.point), k]));
        const url = this.endpoint("table", points.map((item) => item.point), request.profile);
        url.searchParams.set("sources", origins.map((item) => index.get(coordinates(item.point))).join(";"));
        url.searchParams.set("destinations", destinations.map((item) => index.get(coordinates(item.point))).join(";"));
        url.searchParams.set("annotations", "duration,distance");
        const payload = await this.get(url, options);
        const durations = matrixRows(payload.durations, origins.length, destinations.length);
        const distances = matrixRows(payload.distances, origins.length, destinations.length);
        origins.forEach((origin, r) => destinations.forEach((destination, c) => {
          const duration = durations[r]![c];
          const distance = distances[r]![c];
          this.roadCells.set(cellKey(origin, destination), { duration: duration!, distance: distance! });
        }));
      }
    }
    }
    return this.result({
      originIds: request.origins.map((item) => item.id), destinationIds: request.destinations.map((item) => item.id),
      cells: request.origins.flatMap((origin) => request.destinations.map((destination): MatrixCell => {
        const { duration, distance } = this.roadCells.get(cellKey(origin, destination))!;
        return duration === null || distance === null
          ? { status: "no_route", originId: origin.id, destinationId: destination.id, reason: "OSRM: дорожный маршрут не найден" }
          : { status: "ok", originId: origin.id, destinationId: destination.id, durationSeconds: duration, distanceMeters: distance };
      })),
    });
  }

  async buildRoute(request: RouteRequest, options: ProviderRequestOptions = {}): Promise<ProviderResult<ReadonlyArray<RouteAlternative>>> {
    this.baseUrl(request.profile);
    if (request.stops.length < 2) throw failure("INVALID_REQUEST", "Для маршрута OSRM нужны минимум две точки.");
    request.stops.forEach((stop) => assertGeoPoint(stop.point));
    if (isDemo(new URL(this.baseUrl(request.profile))) && request.stops.length > 100) throw failure("INVALID_REQUEST", "Для маршрута более 100 точек нужен собственный сервер OSRM.");
    const geometry: GeoPoint[] = [];
    const legs: RouteLeg[] = [];
    // Overlap adjacent blocks so the complete route has no missing connecting leg.
    for (let start = 0; start < request.stops.length - 1; start += 24) {
      const stops = request.stops.slice(start, start + 25);
      const url = this.endpoint("route", stops.map((stop) => stop.point), request.profile);
      url.searchParams.set("overview", "full");
      url.searchParams.set("geometries", "geojson");
      url.searchParams.set("steps", "true");
      url.searchParams.set("alternatives", "false");
      url.searchParams.set("continue_straight", "false");
      const payload = await this.get(url, options);
      const route = object(Array.isArray(payload.routes) ? payload.routes[0] : undefined);
      if (!route || !Array.isArray(route.legs) || route.legs.length !== stops.length - 1) throw failure("BAD_RESPONSE", "OSRM вернул неполный маршрут.");
      append(geometry, parseGeometry(route.geometry));
      route.legs.forEach((value, index) => {
        const leg = object(value);
        if (!leg || !Array.isArray(leg.steps)) throw failure("BAD_RESPONSE", "OSRM вернул некорректный участок маршрута.");
        const legGeometry: GeoPoint[] = [];
        for (const step of leg.steps) append(legGeometry, parseGeometry(object(step)?.geometry));
        legs.push({ fromStopId: stops[index]!.id, toStopId: stops[index + 1]!.id,
          durationSeconds: metric(leg.duration), distanceMeters: metric(leg.distance), geometry: legGeometry });
      });
    }
    return this.result([{ id: "osrm:route", geometry, legs,
      durationSeconds: legs.reduce((sum, leg) => sum + leg.durationSeconds, 0),
      distanceMeters: legs.reduce((sum, leg) => sum + leg.distanceMeters, 0) }]);
  }

  private baseUrl(profile: TravelProfile): string {
    if (profile.mode === "driving") return this.config.drivingUrl?.trim() || DEMO_DRIVING;
    if (profile.mode === "walking") return this.config.walkingUrl?.trim() || DEMO_WALKING;
    if (profile.mode === "cycling") {
      if (this.config.cyclingUrl?.trim()) return this.config.cyclingUrl.trim();
      throw failure("NOT_SUPPORTED","Не подключён велосипедный маршрутизатор OSRM. Выберите 2ГИС или подключите велосипедный профиль.");
    }
    throw failure("NOT_SUPPORTED", "OSRM в этой системе поддерживает автомобиль и пешие маршруты. Для общественного транспорта выберите 2ГИС.");
  }

  private endpoint(service: string, points: ReadonlyArray<GeoPoint>, profile: TravelProfile): URL {
    let base: URL;
    try { base = new URL(this.baseUrl(profile)); } catch { throw failure("INVALID_REQUEST", "Некорректный адрес сервера OSRM."); }
    if (!["http:", "https:"].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw failure("INVALID_REQUEST", "Адрес сервера OSRM должен быть HTTP(S) URL без параметров и пароля.");
    // OSRM selects the graph at server startup; the path profile alone cannot change a car graph into a foot graph.
    return new URL(`${base.href.replace(/\/$/, "")}/${service}/v1/${profile.mode === "walking" ? "foot" : profile.mode === "cycling" ? "bike" : "driving"}/${points.map(coordinates).join(";")}`);
  }

  private async get(url: URL, options: ProviderRequestOptions): Promise<Record<string, unknown>> {
    const demo = isDemo(url);
    const run = async () => {
      if (demo) {
        await pause(Math.max(0, lastDemoRequest + 1100 - Date.now()), options.signal);
        lastDemoRequest = Date.now();
      }
      const timeout = AbortSignal.timeout(options.timeoutMs ?? 15_000);
      const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
      try {
        signal.throwIfAborted();
        const response = await this.fetcher(url, { signal, cache: "no-store", headers: { Accept: "application/json", "User-Agent": "MMI-Field-Service-Planner/1.0 (OSRM integration)" } });
        if (!response.ok) throw failure(response.status === 429 ? "RATE_LIMITED" : "UNAVAILABLE", `OSRM недоступен (HTTP ${response.status}). Проверьте сервер OSRM или выберите 2ГИС.`, response.status);
        const payload = object(await response.json());
        if (!payload) throw failure("BAD_RESPONSE", "OSRM вернул некорректный ответ.");
        if (payload.code !== "Ok") throw failure(payload.code === "NoRoute" || payload.code === "NoSegment" || payload.code === "NoTable" ? "NO_ROUTE" : "BAD_RESPONSE", `OSRM не смог построить дорожный маршрут (${String(payload.code)}).`);
        // Never request or accept straight-line fallback cells as road results.
        if (Array.isArray(payload.fallback_speed_cells) && payload.fallback_speed_cells.length) throw failure("BAD_RESPONSE", "OSRM вернул оценку по прямой вместо дорожной матрицы.");
        return payload;
      } catch (cause) {
        if (options.signal?.aborted) throw failure("CANCELLED", "Расчёт OSRM отменён.");
        if (timeout.aborted) throw failure("TIMEOUT", "OSRM не ответил вовремя. Повторите расчёт или выберите 2ГИС.");
        if (cause instanceof ProviderError) throw cause;
        throw failure(cause instanceof SyntaxError ? "BAD_RESPONSE" : "UNAVAILABLE", "Не удалось получить дорожные данные OSRM. Проверьте подключение или выберите 2ГИС.");
      }
    };
    if (!demo) return run();
    const pending = demoQueue.then(run);
    demoQueue = pending.then(() => undefined, () => undefined);
    if (!options.signal) return pending;
    const signal = options.signal;
    return new Promise((resolve, reject) => {
      const abort = () => reject(failure("CANCELLED", "Расчёт OSRM отменён."));
      if (signal.aborted) { abort(); return; }
      signal.addEventListener("abort", abort, { once: true });
      pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    });
  }

  private result<T>(data: T): ProviderResult<T> {
    return { data, meta: { providerId: this.providerId, receivedAt: new Date().toISOString(), cache: "bypass" } };
  }
}

function coordinates(point: GeoPoint) { return `${point.lon},${point.lat}`; }
function isDemo(url: URL) { return url.hostname === "router.project-osrm.org" || url.hostname === "routing.openstreetmap.de"; }
function object(value: unknown): Record<string, unknown> | undefined { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
function metric(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw failure("BAD_RESPONSE", "OSRM вернул некорректное время или расстояние.");
  return value;
}
function matrixRows(value: unknown, rows: number, columns: number): Array<Array<number | null>> {
  if (!Array.isArray(value) || value.length !== rows) throw failure("BAD_RESPONSE", "OSRM вернул неполную матрицу.");
  return value.map((row: unknown) => {
    if (!Array.isArray(row) || row.length !== columns) throw failure("BAD_RESPONSE", "OSRM вернул неполную строку матрицы.");
    return row.map((cell: unknown) => cell === null ? null : metric(cell));
  });
}
function parseGeometry(value: unknown): GeoPoint[] {
  const geometry = object(value);
  if (geometry?.type !== "LineString" || !Array.isArray(geometry.coordinates) || geometry.coordinates.length < 2) throw failure("BAD_RESPONSE", "OSRM не вернул дорожную линию.");
  return geometry.coordinates.map((pair: unknown) => {
    if (!Array.isArray(pair) || typeof pair[0] !== "number" || typeof pair[1] !== "number") throw failure("BAD_RESPONSE", "OSRM вернул некорректные координаты.");
    const point = { lon: pair[0], lat: pair[1] };
    try { assertGeoPoint(point); } catch { throw failure("BAD_RESPONSE", "OSRM вернул координаты за пределами карты."); }
    return point;
  });
}
function append(target: GeoPoint[], points: GeoPoint[]) {
  for (const point of points) if (!target.length || coordinates(target.at(-1)!) !== coordinates(point)) target.push(point);
}
function failure(code: ConstructorParameters<typeof ProviderError>[0]["code"], message: string, httpStatus?: number) {
  return new ProviderError({ code, providerId: "osrm", message, retryable: ["TIMEOUT", "UNAVAILABLE", "RATE_LIMITED"].includes(code), ...(httpStatus === undefined ? {} : { httpStatus }) });
}
async function pause(ms: number, signal?: AbortSignal) {
  if (signal?.aborted) throw failure("CANCELLED", "Расчёт OSRM отменён.");
  if (ms <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { signal?.removeEventListener("abort", aborted); resolve(); }, ms);
    function aborted() { clearTimeout(timer); reject(failure("CANCELLED", "Расчёт OSRM отменён.")); }
    signal?.addEventListener("abort", aborted, { once: true });
  });
}
