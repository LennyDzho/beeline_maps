"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createMapView } from "@/app/lib/maps";
import type { MapConfig, MapView, MapLayer } from "@/app/lib/maps/contracts";
import { apiRequest } from "@/app/lib/api-client";
import type { PreviousPlanningRoute } from "./planning-types";

import type { MapRoute } from "./assigned-routes";

type PlanningMapProps = {
  provider?: "two_gis" | "osrm";
  zoom: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  selectedEngineer: string;
  routes?: MapRoute[];
  previousRoutes?: PreviousPlanningRoute[];
  unassignedCount?: number;
};

const ROUTE_COLORS = ["#d2aa32", "#75558f", "#227c6c", "#cb5d47", "#3976a8", "#8b6d2e"];


export default function PlanningMap({
  provider,
  zoom,
  onZoomIn,
  onZoomOut,
  selectedEngineer,
  routes = [],
  previousRoutes = [],
  unassignedCount = 0,
}: PlanningMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapView | null>(null);
  const objectsRef = useRef<MapLayer[]>([]);
  const previousZoom = useRef(zoom);
  const [mapState, setMapState] = useState<"loading" | "ready" | "error">("loading");
  const mapName = provider === "osrm" ? "OpenStreetMap" : provider === "two_gis" ? "2ГИС" : "";
  const [mapMessage, setMapMessage] = useState("Загрузка карты…");
  const [mapAttempt, setMapAttempt] = useState(0);
  const visibleRoutes = useMemo(() => selectedEngineer === "all" ? routes : routes.filter((route) => route.agentId === selectedEngineer), [routes, selectedEngineer]);
  const visiblePrevious = useMemo(() => selectedEngineer === "all" ? previousRoutes : previousRoutes.filter(route=>route.agentId===selectedEngineer),[previousRoutes,selectedEngineer]);

  useEffect(() => {
    if (!provider) return;
    let active = true;
    let completed = false;
    let view: MapView | undefined;
    let readinessTimeout: ReturnType<typeof setTimeout> | undefined;
    const fail = (message: string) => {
      if (!active || completed) return;
      completed = true;
      if (readinessTimeout) clearTimeout(readinessTimeout);
      setMapState("error");
      setMapMessage(message + " Назначения и порядок заявок доступны в списке исполнителей.");
    };
    apiRequest<MapConfig>("/api/map-config").then(async config => {
      if (!active || !containerRef.current) return;
      readinessTimeout = setTimeout(() => fail("Сервис карты не ответил вовремя."), 25_000);
      view = await createMapView(containerRef.current, config, {
        center: routeCenter(routes) ?? [37.6176, 55.7558], zoom,
        onReady: () => {
          if (!active || completed) return;
          completed = true;
          if (readinessTimeout) clearTimeout(readinessTimeout);
          setMapState("ready"); setMapMessage("");
        },
        onError: fail,
      });
      if (!active) { view.destroy(); return; }
      mapRef.current = view;
    }).catch(error => fail(error instanceof Error ? error.message : "Не удалось загрузить карту."));
    return () => {
      active = false;
      if (readinessTimeout) clearTimeout(readinessTimeout);
      destroyObjects(objectsRef.current);
      view?.destroy();
      objectsRef.current = [];
      mapRef.current = null;
    };
  // Provider changes remount this component; route changes only update its layers.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapAttempt, provider]);

  useEffect(() => {
    const map = mapRef.current;
    if (mapState !== "ready" || !map) return;
    destroyObjects(objectsRef.current);
    const objects: MapLayer[] = [];
    visiblePrevious.forEach(route=>{
      if (route.geometrySource!=="fallback" && route.geometry.length>=2) objects.push(map.addLine({
        coordinates:route.geometry.map(point=>[point.lon,point.lat]),width:12,color:"#64748baa",zIndex:8,
      }));
      route.visits.forEach((visit,index)=>{
        if (!visit.point) return;
        const coordinates: [number, number]=[visit.point.lon,visit.point.lat];
        objects.push(map.addMarker({coordinates,radius:13,color:"#64748b",strokeWidth:2,strokeColor:"#ffffff",zIndex:18}));
        objects.push(map.addLabel({coordinates,text:`До: ${index+1}. ${visit.label}`,offset:[0,22],color:"#475569",haloColor:"#ffffff",haloRadius:3,fontSize:12,zIndex:24}));
      });
    });
    visibleRoutes.forEach((route) => {
      const routeIndex = routes.findIndex((candidate) => candidate.agentId === route.agentId);
      const color = ROUTE_COLORS[Math.max(0, routeIndex) % ROUTE_COLORS.length]!;
      const geometry = (route.geometrySource !== "fallback" && route.geometry.length >= 2 ? route.geometry : [])
        .map((point): [number, number] => [point.lon, point.lat]);
      if (geometry.length >= 2) {
        objects.push(map.addLine( { coordinates: geometry, width: 9, color: "#ffffffdd", zIndex: 10 }));
        objects.push(map.addLine( {
          coordinates: geometry,
          width: 5,
          color,
          zIndex: 11,
        }));
      }
      if (route.startPoint) {
        objects.push(map.addMarker( {
          coordinates: [route.startPoint.lon, route.startPoint.lat],
          radius: 8,
          color: "#103a2d",
          strokeWidth: 3,
          strokeColor: "#ffffff",
          zIndex: 20,
        }));
        objects.push(map.addLabel( {
          coordinates: [route.startPoint.lon, route.startPoint.lat],
          text: "Старт",
          offset: [0, -17],
          color: "#103a2d",
          haloColor: "#ffffff",
          haloRadius: 2,
          fontSize: 12,
          zIndex: 21,
        }));
      }
      route.visits.forEach((visit, index) => {
        const coordinates: [number, number] = [visit.point.lon, visit.point.lat];
        objects.push(map.addMarker( { coordinates, radius: 9, color, strokeWidth: 3, strokeColor: "#ffffff", zIndex: 22 }));
        objects.push(map.addLabel( {
          coordinates,
          text: `${index + 1}. ${visit.label}`,
          offset: [0, -20],
          color: "#2f2732",
          haloColor: "#ffffff",
          haloRadius: 3,
          fontSize: 13,
          zIndex: 23,
        }));
      });
    });
    objectsRef.current = objects;
    fitRoutes(map, visibleRoutes, visiblePrevious);
    return () => {
      destroyObjects(objects);
      if (objectsRef.current === objects) objectsRef.current = [];
    };
  }, [mapState, routes, selectedEngineer, visibleRoutes, visiblePrevious]);

  useEffect(() => {
    const delta = zoom - previousZoom.current;
    previousZoom.current = zoom;
    if (mapState === "ready" && delta && mapRef.current) {
      mapRef.current.setZoom(mapRef.current.getZoom() + delta);
    }
  }, [mapState, zoom]);

  return (
    <section className={`planning-map${provider === "osrm" ? " planning-map-osm" : ""}`} aria-label="Карта маршрутов">
      <div className="planning-map-fallback" aria-hidden="true" />
      <div className={`planning-map-canvas ${mapState === "ready" ? "ready" : ""}`}>
        {/* SDK classes belong to a stable element: React must not replace them when readiness changes. */}
        <div className="planning-map-surface" ref={containerRef} />
      </div>
      {mapState !== "ready" && <div className={`planning-map-status ${mapState}`} role="status">
        <strong>{mapState === "error" ? "Карта временно недоступна" : `Карта ${mapName}`}</strong>
        <span>{mapMessage}</span>
        {mapState === "error" && <button type="button" onClick={() => {
          setMapState("loading");
          setMapMessage(`Загрузка карты ${mapName}…`);
          setMapAttempt((attempt) => attempt + 1);
        }}>Повторить загрузку</button>}
      </div>}

      {mapState === "ready" && <div className="map-zoom">
        <button type="button" onClick={onZoomIn} aria-label="Увеличить карту">+</button>
        <button type="button" onClick={onZoomOut} aria-label="Уменьшить карту">−</button>
      </div>}

      {mapState === "ready" && <details className="stitch-map-legend">
        <summary>Маршруты исполнителей · {visibleRoutes.length}</summary>
        <div className="map-legend-items">
        {visiblePrevious.length>0 && <span><i style={{backgroundColor:"#64748b"}} />До пересчёта · {visiblePrevious.length}{visiblePrevious.some(r=>r.geometrySource==="fallback") ? " · часть дорожных линий недоступна" : ""}</span>}
        {visibleRoutes.length ? visibleRoutes.map((route) => <span key={route.agentId}>
          <i style={{ backgroundColor: ROUTE_COLORS[Math.max(0, routes.findIndex((candidate) => candidate.agentId === route.agentId)) % ROUTE_COLORS.length] }} /> {route.agentName}
          {route.geometrySource === "fallback" ? " · дорожная геометрия недоступна" : route.geometrySource === "osrm" ? " · по дорогам OSRM / OSM" : " · по дорогам 2ГИС"}
        </span>) : <span className="legend-muted"><i />{visiblePrevious.length ? "После пересчёта заявок нет" : "На выбранный день нет назначенных маршрутов"}</span>}
        <span className="legend-muted"><i /> Ожидают распределения{unassignedCount ? `: ${unassignedCount}` : ""}</span>
        {[...visibleRoutes,...visiblePrevious].some((route) => route.geometrySource === "osrm") && <small>Маршруты: <a href="https://project-osrm.org/" target="_blank" rel="noreferrer">OSRM</a> · © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap contributors</a> · <a href="https://www.openstreetmap.org/fixthemap" target="_blank" rel="noreferrer">Исправить карту</a></small>}
        </div>
      </details>}
    </section>
  );
}

function fitRoutes(map: MapView, routes: MapRoute[], previous: PreviousPlanningRoute[]) {
  const points = [...routes.flatMap((route) => [...(route.startPoint ? [route.startPoint] : []), ...route.visits.map((visit) => visit.point)]),
    ...previous.flatMap(route=>[route.startPoint,...route.visits.map(visit=>visit.point)]).filter((point): point is {lat:number;lon:number}=>point!==null)];
  if (points.length === 0) return;
  if (points.length === 1) {
    map.setCenter([points[0]!.lon, points[0]!.lat]);
    map.setZoom(14);
    return;
  }
  const lons = points.map((point) => point.lon);
  const lats = points.map((point) => point.lat);
  map.fitBounds({
    northEast: [Math.max(...lons), Math.max(...lats)],
    southWest: [Math.min(...lons), Math.min(...lats)],
  }, { padding: { top: 70, right: 70, bottom: 150, left: 70 }, maxZoom: 15 });
}

function routeCenter(routes: MapRoute[]): [number, number] | undefined {
  const points = routes.flatMap((route) => route.visits.map((visit) => visit.point));
  if (!points.length) return undefined;
  return [points.reduce((sum, point) => sum + point.lon, 0) / points.length, points.reduce((sum, point) => sum + point.lat, 0) / points.length];
}

function destroyObjects(objects: MapLayer[]) {
  for (const object of objects) object.destroy();
}
