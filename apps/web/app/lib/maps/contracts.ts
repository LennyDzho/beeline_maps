// Coordinates at the application boundary are always [longitude, latitude].
export type MapPoint = [number, number];
export type MapConfig = { providerId: "2gis"; mapKey: string } | { providerId: "osm"; tileUrl: string };
export type MapLayer = { destroy(): void };
export type MapBounds = { northEast: MapPoint; southWest: MapPoint };
export type FitOptions = { padding?: { top: number; right: number; bottom: number; left: number }; maxZoom?: number };
export type LineOptions = { coordinates: MapPoint[]; width: number; color: string; zIndex: number };
export type MarkerOptions = { coordinates: MapPoint; radius: number; color: string; strokeWidth: number; strokeColor: string; zIndex: number };
export type LabelOptions = { coordinates: MapPoint; text: string; offset: MapPoint; color: string; haloColor: string; haloRadius: number; fontSize: number; zIndex: number };
export type MapViewOptions = { center: MapPoint; zoom: number; onReady(): void; onError(message: string): void };

/** Application-facing map API. SDK objects never escape provider adapters. */
export interface MapView {
  addLine(options: LineOptions): MapLayer;
  addMarker(options: MarkerOptions): MapLayer;
  addLabel(options: LabelOptions): MapLayer;
  fitBounds(bounds: MapBounds, options?: FitOptions): void;
  setCenter(center: MapPoint): void;
  setZoom(zoom: number): void;
  getZoom(): number;
  destroy(): void;
}
