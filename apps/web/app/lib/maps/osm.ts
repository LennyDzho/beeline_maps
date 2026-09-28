import * as L from "leaflet";
import type { MapConfig, MapPoint, MapView, MapViewOptions } from "./contracts";

const latLng = ([lon, lat]: MapPoint): L.LatLngTuple => [lat, lon];

export function createOsmMap(container: HTMLElement, config: Extract<MapConfig, { providerId: "osm" }>, options: MapViewOptions): MapView {
  const map = L.map(container, { zoomControl: false, attributionControl: true, minZoom: 2, maxZoom: 19 })
    .setView(latLng(options.center), options.zoom);
  map.attributionControl.setPrefix(false);
  const tiles = L.tileLayer(config.tileUrl, { maxZoom: 19, updateWhenIdle: true, keepBuffer: 1,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap contributors</a>',
  });
  let loaded = false;
  tiles.on("tileload", () => { if (!loaded) { loaded = true; options.onReady(); } });
  tiles.on("load", () => { if (!loaded) options.onError("Не удалось загрузить карту OpenStreetMap. Проверьте подключение и повторите загрузку."); });
  tiles.addTo(map);
  const resize = new ResizeObserver(() => map.invalidateSize({ pan: false }));
  resize.observe(container);
  const layer = (item: L.Layer) => { item.addTo(map); return { destroy: () => item.remove() }; };
  const pane = (zIndex: number) => {
    const name = `route-${zIndex}`;
    if (!map.getPane(name)) map.createPane(name).style.zIndex = String(400 + zIndex);
    return name;
  };
  return {
    addLine: item => layer(L.polyline(item.coordinates.map(latLng), { pane: pane(item.zIndex), color: item.color, weight: item.width, interactive: false })),
    addMarker: item => layer(L.circleMarker(latLng(item.coordinates), { radius: item.radius, color: item.strokeColor,
      pane: pane(item.zIndex), weight: item.strokeWidth, fillColor: item.color, fillOpacity: 1, interactive: false })),
    addLabel: item => {
      const text = document.createElement("span");
      text.textContent = item.text;
      text.style.color = item.color;
      text.style.fontSize = `${item.fontSize}px`;
      text.style.textShadow = `0 0 ${item.haloRadius}px ${item.haloColor}`;
      return layer(L.tooltip({ pane: pane(item.zIndex), permanent: true, direction: "center", offset: item.offset, className: "osm-route-label", opacity: 1 })
        .setLatLng(latLng(item.coordinates)).setContent(text));
    },
    fitBounds: (bounds, fit) => map.fitBounds([latLng(bounds.southWest), latLng(bounds.northEast)], {
      maxZoom: fit?.maxZoom, animate: false,
      paddingTopLeft: fit?.padding ? [fit.padding.left, fit.padding.top] : undefined,
      paddingBottomRight: fit?.padding ? [fit.padding.right, fit.padding.bottom] : undefined,
    }),
    setCenter: center => { map.panTo(latLng(center), { animate: false }); },
    setZoom: zoom => { map.setZoom(zoom, { animate: false }); },
    getZoom: () => map.getZoom(),
    destroy: () => { resize.disconnect(); map.remove(); },
  };
}
