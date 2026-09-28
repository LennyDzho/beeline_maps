import { env } from "cloudflare:workers";
import { fetchTwoGis } from "./planning/two-gis-fetch";

export type GeocodedAddress = {
  formattedAddress: string;
  point: { lat: number; lon: number };
  precision: "building" | "street" | "locality" | "unknown";
  providerRef?: { providerId: "two-gis"; objectId: string };
};

type TwoGisItem = {
  id?: unknown;
  type?: unknown;
  name?: unknown;
  address_name?: unknown;
  full_name?: unknown;
  point?: { lat?: unknown; lon?: unknown };
};

type TwoGisResponse = {
  meta?: { code?: unknown; error?: { message?: unknown } };
  result?: { items?: unknown };
};

export class GeocodingError extends Error {
  constructor(
    readonly code: "NOT_CONFIGURED" | "NOT_FOUND" | "PROVIDER_ERROR" | "BAD_RESPONSE",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "GeocodingError";
  }
}

/** Resolves an address through the configured provider; coordinates never come from the browser. */
export async function geocodeAddress(query: string): Promise<GeocodedAddress> {
  const normalizedQuery = query.trim().replace(/\s+/g, " ");
  if (normalizedQuery.length < 3 || normalizedQuery.length > 500) {
    throw new GeocodingError("NOT_FOUND", "Введите более точный адрес длиной от 3 до 500 символов.");
  }

  const apiKey = env.TWO_GIS_API_KEY?.trim();
  if (!apiKey) {
    throw new GeocodingError("NOT_CONFIGURED", "Геокодирование не настроено: отсутствует TWO_GIS_API_KEY.");
  }

  const endpoint = new URL("https://catalog.api.2gis.com/3.0/items/geocode");
  endpoint.searchParams.set("q", normalizedQuery);
  endpoint.searchParams.set("fields", "items.point");
  endpoint.searchParams.set("page_size", "5");
  endpoint.searchParams.set("key", apiKey);

  let response: Response;
  try {
    response = await fetchTwoGis(endpoint, {
      headers: { Accept: "application/json" },
      cache: "no-store",
    }, { timeoutMs: 8_000, attempts: 2 });
  } catch (cause) {
    throw new GeocodingError("PROVIDER_ERROR", "Сервис геокодирования временно недоступен.", { cause });
  }

  let payload: TwoGisResponse;
  try {
    payload = await response.json() as TwoGisResponse;
  } catch (cause) {
    throw new GeocodingError("BAD_RESPONSE", "Сервис геокодирования вернул некорректный ответ.", { cause });
  }

  if (!response.ok || payload.meta?.code !== 200) {
    const providerMessage = payload.meta?.error?.message;
    throw new GeocodingError(
      "PROVIDER_ERROR",
      typeof providerMessage === "string" && providerMessage.trim() ? providerMessage : "Не удалось определить координаты адреса.",
    );
  }

  const rawItems = Array.isArray(payload.result?.items) ? payload.result.items : [];
  const candidates = rawItems.flatMap((rawItem) => toCandidate(rawItem));
  const candidate = candidates.find((item) => item.precision === "building") ?? candidates[0];
  if (!candidate) {
    throw new GeocodingError("NOT_FOUND", "Адрес не найден. Уточните город, улицу и номер дома.");
  }
  return candidate;
}

function toCandidate(value: unknown): GeocodedAddress[] {
  if (!value || typeof value !== "object") return [];
  const item = value as TwoGisItem;
  const lat = item.point?.lat;
  const lon = item.point?.lon;
  if (typeof lat !== "number" || typeof lon !== "number" || !Number.isFinite(lat) || !Number.isFinite(lon)) return [];
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return [];

  const formattedAddress = firstText(item.full_name, item.address_name, item.name);
  if (!formattedAddress) return [];

  const type = typeof item.type === "string" ? item.type : "";
  const precision = type === "building" || type === "branch"
    ? "building"
    : type === "street"
      ? "street"
      : type.startsWith("adm_div")
        ? "locality"
        : "unknown";
  const objectId = typeof item.id === "string" && item.id ? item.id : undefined;

  return [{
    formattedAddress,
    point: { lat, lon },
    precision,
    ...(objectId ? { providerRef: { providerId: "two-gis" as const, objectId } } : {}),
  }];
}

function firstText(...values: ReadonlyArray<unknown>): string | undefined {
  return values.find((value): value is string => typeof value === "string" && value.trim().length > 0)?.trim();
}
