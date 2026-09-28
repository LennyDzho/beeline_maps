import type { MapConfig, MapView, MapViewOptions } from "./contracts";

/** Only this factory selects a browser SDK; callers use the same MapView API. */
export async function createMapView(container: HTMLElement, config: MapConfig, options: MapViewOptions): Promise<MapView> {
  if (config.providerId === "osm") {
    const { createOsmMap } = await import("./osm");
    return createOsmMap(container, config, options);
  }
  const { createTwoGisMap } = await import("./two-gis");
  return createTwoGisMap(container, config, options);
}
