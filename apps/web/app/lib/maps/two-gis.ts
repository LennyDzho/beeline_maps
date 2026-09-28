import type { MapConfig, MapView, MapViewOptions } from "./contracts";
type MapGlObject = { destroy: () => void };
type MapGlMap = MapGlObject & {
  on: (event: "idle" | "styleloaderror", handler: () => void) => void;
  fitBounds: (bounds: { northEast: [number, number]; southWest: [number, number] }, options?: { padding?: { top: number; right: number; bottom: number; left: number }; maxZoom?: number }) => void;
  setCenter: (center: [number, number]) => void;
  setZoom: (zoom: number) => void;
  getZoom: () => number;
  setControlsLayoutPadding: (padding: { top?: number; right?: number; bottom?: number; left?: number }) => void;
};
type MapGlModule = {
  Map: new (container: HTMLElement, options: Record<string, unknown>) => MapGlMap;
  Polyline: new (map: MapGlMap, options: Record<string, unknown>) => MapGlObject;
  CircleMarker: new (map: MapGlMap, options: Record<string, unknown>) => MapGlObject;
  Label: new (map: MapGlMap, options: Record<string, unknown>) => MapGlObject;
};

declare global {
  interface Window { mapgl?: MapGlModule }
}


let mapGlLoader: Promise<MapGlModule> | undefined;
export async function createTwoGisMap(container: HTMLElement, config: Extract<MapConfig, { providerId: "2gis" }>, options: MapViewOptions): Promise<MapView> {
  const sdk = await loadMapGl();
  const map = new sdk.Map(container, {center: options.center, zoom: options.zoom, key: config.mapKey,
    lang: "ru", enableTrackResize: true, zoomControl: false, trafficControl: "topRight", scaleControl: "bottomRight", copyright: "bottomLeft"});
  map.setControlsLayoutPadding({right:16,bottom:16,left:16});
  map.on("idle", options.onReady);
  map.on("styleloaderror", () => options.onError("2ГИС не смог загрузить оформление карты."));
  return {
    addLine: item => new sdk.Polyline(map,item),
    addMarker: item => new sdk.CircleMarker(map,item),
    addLabel: item => new sdk.Label(map,item),
    fitBounds: (bounds,fit) => map.fitBounds(bounds,fit),
    setCenter: center => map.setCenter(center), setZoom: zoom => map.setZoom(zoom), getZoom: () => map.getZoom(),
    destroy: () => map.destroy(),
  };
}
function loadMapGl(): Promise<MapGlModule> {
  if (window.mapgl) return Promise.resolve(window.mapgl);
  if (mapGlLoader) return mapGlLoader;
  const pending = new Promise<MapGlModule>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>('script[data-mapgl="2gis"]');
    const script = existing ?? document.createElement("script");
    let finished = false;
    const finish = (error?: Error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      script.removeEventListener("load", onLoad);
      script.removeEventListener("error", onError);
      if (error) { script.remove(); reject(error); }
      else resolve(window.mapgl!);
    };
    const onLoad = () => finish(window.mapgl ? undefined : new Error("Библиотека MapGL загрузилась без API."));
    const onError = () => finish(new Error("Не удалось загрузить библиотеку MapGL 2ГИС."));
    const timeout = setTimeout(() => finish(new Error("Сервер библиотеки карты 2ГИС не ответил вовремя.")), 20_000);
    script.addEventListener("load", onLoad, { once: true });
    script.addEventListener("error", onError, { once: true });
    if (!existing) {
      script.src = "https://mapgl.2gis.com/api/js/v1";
      script.async = true;
      script.defer = true;
      script.dataset.mapgl = "2gis";
      document.head.appendChild(script);
    }
  });
  mapGlLoader = pending;
  // A rejected promise must not poison the retry button or a later page visit.
  void pending.catch(() => { if (mapGlLoader === pending) mapGlLoader = undefined; });
  return pending;
}

