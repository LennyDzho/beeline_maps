import { readFile } from "node:fs/promises";

const variables = await readVariables(new URL("../.dev.vars", import.meta.url));
const key = variables.TWO_GIS_API_KEY?.trim();
if (!key) fail("TWO_GIS_API_KEY отсутствует в apps/web/.dev.vars.");
if (!variables.TWO_GIS_MAPGL_KEY?.trim()) fail("TWO_GIS_MAPGL_KEY отсутствует в apps/web/.dev.vars.");

const geocoding = new URL("https://catalog.api.2gis.com/3.0/items/geocode");
geocoding.search = new URLSearchParams({
  q: "Москва, Тверская улица, 18",
  fields: "items.point",
  page_size: "1",
  key,
}).toString();
const geocodingResponse = await fetch(geocoding, { signal: AbortSignal.timeout(15_000) });
const geocodingPayload = await geocodingResponse.json();
const item = geocodingPayload?.result?.items?.[0];
if (!geocodingResponse.ok || !item?.point) fail(`Geocoding API: HTTP ${geocodingResponse.status}, meta ${geocodingPayload?.meta?.code ?? "unknown"}.`);
console.log("Geocoding API: OK (координаты получены). ");

const matrix = new URL("https://routing.api.2gis.com/get_dist_matrix");
matrix.search = new URLSearchParams({ key, version: "2.0" }).toString();
const matrixResponse = await fetch(matrix, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    points: [item.point, { lat: 55.75222, lon: 37.61556 }],
    sources: [0],
    targets: [1],
    transport: "driving",
    type: "statistics",
    start_time: "2026-08-20T08:00:00+03:00",
  }),
  signal: AbortSignal.timeout(15_000),
});
const matrixPayload = await matrixResponse.json();
const matrixRoute = matrixPayload?.routes?.[0];
if (!matrixResponse.ok || matrixRoute?.status !== "OK") fail(`Distance Matrix API: HTTP ${matrixResponse.status}, status ${matrixRoute?.status ?? "unknown"}.`);
console.log(`Distance Matrix API: OK (${matrixRoute.duration} с, ${matrixRoute.distance} м).`);

const routing = new URL("https://routing.api.2gis.com/routing/7.0.0/global");
routing.searchParams.set("key", key);
const routingResponse = await fetch(routing, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    points: [
      { type: "stop", ...item.point },
      { type: "stop", lat: 55.75222, lon: 37.61556 },
    ],
    transport: "driving",
    output: "detailed",
    locale: "ru",
    route_mode: "fastest",
    traffic_mode: "jam",
  }),
  signal: AbortSignal.timeout(20_000),
});
const routingPayload = await routingResponse.json();
const routingRoute = routingPayload?.result?.[0];
const geometryParts = collectLineStrings(routingRoute);
if (!routingResponse.ok || routingPayload?.status !== "OK" || geometryParts.length === 0) {
  fail(`Routing API: HTTP ${routingResponse.status}, status ${routingPayload?.status ?? "unknown"}, geometry ${geometryParts.length}.`);
}
console.log(`Routing API: OK (${routingRoute.total_duration} с, ${routingRoute.total_distance} м, ${geometryParts.length} частей геометрии).`);

const mapGlResponse = await fetch("https://mapgl.2gis.com/api/js/v1", { signal: AbortSignal.timeout(20_000) });
if (!mapGlResponse.ok) fail(`MapGL API: HTTP ${mapGlResponse.status}.`);
console.log("MapGL API: OK (клиентская библиотека доступна). ");

async function readVariables(url) {
  const source = await readFile(url, "utf8");
  return Object.fromEntries(source.split(/\r?\n/u).flatMap((line) => {
    const normalized = line.trim();
    if (!normalized || normalized.startsWith("#") || !normalized.includes("=")) return [];
    const separator = normalized.indexOf("=");
    return [[normalized.slice(0, separator).trim(), normalized.slice(separator + 1).trim()]];
  }));
}

function collectLineStrings(value, result = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectLineStrings(item, result);
    return result;
  }
  if (!value || typeof value !== "object") return result;
  if (typeof value.selection === "string" && value.selection.startsWith("LINESTRING")) result.push(value.selection);
  for (const [name, child] of Object.entries(value)) {
    if (name !== "selection") collectLineStrings(child, result);
  }
  return result;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
