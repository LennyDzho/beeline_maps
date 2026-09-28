import { NextResponse } from "next/server";
import { clearSessionCookie, deleteSession, getSessionCookieName } from "@/auth/session";
import { clearOrganizationCookie } from "@/auth/organization-context";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  if (!hasSameOrigin(request)) {
    return NextResponse.json({ message: "Недопустимый источник запроса." }, { status: 403 });
  }

  const token = readCookie(request.headers.get("cookie"), getSessionCookieName());
  await deleteSession(token);

  const response = NextResponse.redirect(new URL("/login", request.url), 303);
  const secure = new URL(request.url).protocol === "https:";
  response.headers.append("Set-Cookie", clearSessionCookie(secure));
  response.headers.append("Set-Cookie", clearOrganizationCookie(secure));
  response.headers.set("Cache-Control", "no-store");
  return response;
}

function readCookie(header: string | null, name: string): string | undefined {
  return header
    ?.split(";")
    .map((part) => part.trim().split("="))
    .find(([cookieName]) => cookieName === name)
    ?.slice(1)
    .join("=");
}

function hasSameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  return !origin || origin === new URL(request.url).origin;
}
