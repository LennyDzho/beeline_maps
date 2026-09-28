interface D1Result<T = unknown> {
  results: T[];
  success: boolean;
  meta: Record<string, unknown>;
}

interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(column?: string): Promise<T | null>;
  run<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  raw<T = unknown[]>(options?: { columnNames?: boolean }): Promise<T[]>;
}

interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
  exec(query: string): Promise<{ count: number; duration: number }>;
  dump(): Promise<ArrayBuffer>;
}

interface Fetcher {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

interface R2StoredObject { size: number; httpEtag: string; range?: { offset: number; length: number }; }
interface R2StoredBody extends R2StoredObject { body: ReadableStream<Uint8Array>; }
interface R2Bucket {
  put(key: string, value: ReadableStream<Uint8Array>, options?: { sha256?: string; httpMetadata?: { contentType: string } }): Promise<R2StoredObject | null>;
  get(key: string, options?: { range?: Headers }): Promise<R2StoredBody | null>;
  delete(key: string): Promise<void>;
}
declare class FixedLengthStream { constructor(length: number); readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array>; }

declare module "cloudflare:workers" {
  export const env: {
    DB: D1Database;
    MEDIA?: R2Bucket;
    AUTH_BOOTSTRAP_EMAIL?: string;
    AUTH_BOOTSTRAP_PASSWORD?: string;
    AUTH_BOOTSTRAP_NAME?: string;
    TWO_GIS_API_KEY?: string;
    TWO_GIS_MAPGL_KEY?: string;
    OSM_TILE_URL?: string;
    OSRM_BASE_URL?: string;
    OSRM_WALKING_BASE_URL?: string;
    OSRM_CYCLING_BASE_URL?: string;
    OPTIMIZER_SERVICE_URL?: string;
    OPTIMIZER_SERVICE_TOKEN?: string;
    PLANNING_DEPOT_LAT?: string;
    PLANNING_DEPOT_LON?: string;
  };
}
