import type {
  GeoBounds,
  GeoPoint,
  ProviderObjectRef,
  ProviderRequestOptions,
  ProviderResult,
} from "./common.js";

export interface AddressComponents {
  readonly country?: string;
  readonly region?: string;
  readonly district?: string;
  readonly locality?: string;
  readonly street?: string;
  readonly house?: string;
  readonly postalCode?: string;
}

export type GeocodePrecision =
  | "exact"
  | "building"
  | "street"
  | "locality"
  | "region"
  | "unknown";

export interface GeocodingCandidate {
  readonly point: GeoPoint;
  readonly formattedAddress: string;
  readonly components: AddressComponents;
  readonly precision: GeocodePrecision;
  /** Normalized score between 0 and 1 when the provider supplies enough data. */
  readonly confidence?: number;
  readonly bounds?: GeoBounds;
  /** A cache hint only; business entities must not use this as their identity. */
  readonly providerRef?: ProviderObjectRef;
}

export interface ForwardGeocodeRequest {
  readonly query: string;
  /** BCP 47 locale such as `ru-RU`. */
  readonly locale?: string;
  readonly limit?: number;
  readonly bias?:
    | { readonly kind: "point"; readonly center: GeoPoint; readonly radiusM?: number }
    | { readonly kind: "bounds"; readonly bounds: GeoBounds };
}

export interface ReverseGeocodeRequest {
  readonly point: GeoPoint;
  readonly locale?: string;
  readonly limit?: number;
}

export interface GeocoderPort {
  readonly providerId: string;

  forward(
    request: ForwardGeocodeRequest,
    options?: ProviderRequestOptions,
  ): Promise<ProviderResult<ReadonlyArray<GeocodingCandidate>>>;

  reverse(
    request: ReverseGeocodeRequest,
    options?: ProviderRequestOptions,
  ): Promise<ProviderResult<ReadonlyArray<GeocodingCandidate>>>;
}

