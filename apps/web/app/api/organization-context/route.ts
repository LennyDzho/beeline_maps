import { NextResponse } from "next/server";
import { isApiError, readJsonObject, requireApiContext, serverError } from "@/app/api/_shared";
import { createOrganizationCookie, listUserOrganizations } from "@/auth/organization-context";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const context = await requireApiContext(request);
    if (isApiError(context)) return context;
    const organizations = await listUserOrganizations(context.database, context.user.id);
    return NextResponse.json({ organizations, currentOrganizationId: context.organizationId }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return serverError(error); }
}

export async function PUT(request: Request) {
  try {
    const context = await requireApiContext(request);
    if (isApiError(context)) return context;
    const body = await readJsonObject(request);
    if (!body || typeof body.organizationId !== "string") return NextResponse.json({ message: "Организация не указана." }, { status: 400 });
    const organizations = await listUserOrganizations(context.database, context.user.id);
    if (!organizations.some((organization) => organization.id === body.organizationId)) {
      return NextResponse.json({ message: "Нет доступа к выбранной организации." }, { status: 403 });
    }
    const response = NextResponse.json({ ok: true, organizationId: body.organizationId });
    response.headers.set("Set-Cookie", createOrganizationCookie(body.organizationId, new URL(request.url).protocol === "https:"));
    response.headers.set("Cache-Control", "private, no-store");
    return response;
  } catch (error) { return serverError(error); }
}
