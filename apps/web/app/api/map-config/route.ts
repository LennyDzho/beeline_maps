import { env } from "cloudflare:workers";
import { NextResponse } from "next/server";
import { isApiError, requireApiContext, serverError } from "@/app/api/_shared";
import { loadPlanningSettings } from "@/app/lib/server/planning/settings-storage";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const context = await requireApiContext(request, "planning.manage");
    if (isApiError(context)) return context;
    const settings = await loadPlanningSettings(context.database);
    if (settings.travelMatrixProvider === "osrm") {
      return NextResponse.json({ providerId: "osm", tileUrl: env.OSM_TILE_URL?.trim() || "https://tile.openstreetmap.org/{z}/{x}/{y}.png" },
        { headers: { "Cache-Control": "private, no-store" } });
    }
    const mapKey = env.TWO_GIS_MAPGL_KEY?.trim();
    if (!mapKey) return NextResponse.json({ message: "Не настроен отдельный ключ TWO_GIS_MAPGL_KEY для карты 2ГИС." }, { status: 424 });
    return NextResponse.json({ providerId: "2gis", mapKey }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return serverError(error);
  }
}
