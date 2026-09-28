import type { GeoBounds, GeoPoint } from "./common.js";

export type MapMarkerRole =
  | "job"
  | "engineer"
  | "depot"
  | "vehicle"
  | "equipment"
  | "alert";

export interface MapMarker {
  readonly id: string;
  readonly point: GeoPoint;
  readonly role: MapMarkerRole;
  readonly label?: string;
  readonly color?: string;
  readonly selected?: boolean;
  readonly zIndex?: number;
}

export interface MapPolyline {
  readonly id: string;
  readonly points: ReadonlyArray<GeoPoint>;
  readonly color: string;
  readonly widthPx?: number;
  readonly opacity?: number;
  readonly dashed?: boolean;
  readonly zIndex?: number;
}

export interface MapViewport {
  readonly center: GeoPoint;
  readonly zoom: number;
  readonly bearing?: number;
  readonly pitch?: number;
}

export interface MapScene {
  readonly viewport?: MapViewport;
  readonly markers: ReadonlyArray<MapMarker>;
  readonly polylines: ReadonlyArray<MapPolyline>;
}

export type MapRendererEvent =
  | { readonly type: "map-click"; readonly point: GeoPoint }
  | { readonly type: "marker-click"; readonly markerId: string }
  | { readonly type: "viewport-change"; readonly viewport: MapViewport };

export interface MapRendererOptions {
  readonly locale?: string;
  readonly theme?: "light" | "dark" | "system";
  readonly interactive?: boolean;
}

export type Unsubscribe = () => void;

/** Frontend port implemented by a 2GIS, Yandex or another map adapter. */
export interface MapRendererPort {
  readonly providerId: string;

  mount(target: Element, scene: MapScene, options?: MapRendererOptions): Promise<void>;
  update(scene: MapScene): Promise<void>;
  fitBounds(bounds: GeoBounds, paddingPx?: number): Promise<void>;
  subscribe(listener: (event: MapRendererEvent) => void): Unsubscribe;
  destroy(): Promise<void>;
}

