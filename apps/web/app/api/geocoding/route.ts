import { NextResponse } from "next/server";
import { isApiError, requireApiContext, serverError } from "@/app/api/_shared";
import { GeocodingError, geocodeAddress } from "@/app/lib/server/geocoding";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const context = await requireApiContext(request);
    if (isApiError(context)) return context;

    const query = new URL(request.url).searchParams.get("query")?.trim() ?? "";
    const candidate = await geocodeAddress(query);
    return NextResponse.json({ candidate });
  } catch (error) {
    if (error instanceof GeocodingError) {
      const status = error.code === "NOT_FOUND" ? 404 : error.code === "NOT_CONFIGURED" ? 503 : 502;
      return NextResponse.json({ message: error.message }, { status });
    }
    return serverError(error);
  }
}
