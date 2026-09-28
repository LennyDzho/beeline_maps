/** RFC 3339 timestamp with an explicit UTC offset. */
export type DateTime = string;

/** Canonical coordinate representation used throughout the application. */
export interface GeoPoint {
  readonly lat: number;
  readonly lon: number;
}

export interface GeoBounds {
  readonly southWest: GeoPoint;
  readonly northEast: GeoPoint;
}

export interface IdentifiedPoint {
  /** Stable application identifier, never a provider object id. */
  readonly id: string;
  readonly point: GeoPoint;
}

export interface TimeWindow {
  readonly startAt: DateTime;
  readonly endAt: DateTime;
}

export interface ProviderObjectRef {
  readonly providerId: string;
  readonly objectId: string;
}

export interface ProviderRequestOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly traceId?: string;
}

export interface ProviderResponseMeta {
  readonly providerId: string;
  readonly requestId?: string;
  readonly receivedAt: DateTime;
  readonly cache: "hit" | "miss" | "bypass";
}

export interface ProviderResult<T> {
  readonly data: T;
  readonly meta: ProviderResponseMeta;
}

export type ProviderErrorCode =
  | "AUTHENTICATION"
  | "FORBIDDEN"
  | "INVALID_REQUEST"
  | "NOT_SUPPORTED"
  | "NO_ROUTE"
  | "RATE_LIMITED"
  | "QUOTA_EXHAUSTED"
  | "TIMEOUT"
  | "UNAVAILABLE"
  | "BAD_RESPONSE"
  | "CANCELLED"
  | "UNKNOWN";

export interface ProviderErrorOptions {
  readonly code: ProviderErrorCode;
  readonly providerId: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly httpStatus?: number;
  readonly requestId?: string;
  readonly cause?: unknown;
}

/** Error type exposed by every provider adapter. */
export class ProviderError extends Error {
  readonly code: ProviderErrorCode;
  readonly providerId: string;
  readonly retryable: boolean;
  readonly httpStatus: number | undefined;
  readonly requestId: string | undefined;

  constructor(options: ProviderErrorOptions) {
    super(options.message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ProviderError";
    this.code = options.code;
    this.providerId = options.providerId;
    this.retryable = options.retryable;
    this.httpStatus = options.httpStatus;
    this.requestId = options.requestId;
  }
}

export function assertGeoPoint(point: GeoPoint): void {
  if (!Number.isFinite(point.lat) || point.lat < -90 || point.lat > 90) {
    throw new RangeError(`Latitude must be between -90 and 90; received ${point.lat}`);
  }

  if (!Number.isFinite(point.lon) || point.lon < -180 || point.lon > 180) {
    throw new RangeError(`Longitude must be between -180 and 180; received ${point.lon}`);
  }
}

export function assertTimeWindow(window: TimeWindow): void {
  const start = Date.parse(window.startAt);
  const end = Date.parse(window.endAt);

  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) {
    throw new RangeError(`Invalid time window: ${window.startAt} - ${window.endAt}`);
  }
}

