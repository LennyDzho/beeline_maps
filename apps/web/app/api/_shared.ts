import { NextResponse } from "next/server";
import { getCurrentUser, type AuthUser } from "@/auth/session";
import { ensureDomainData } from "@/db/domain-storage";
import { resolveUserOrganizationContext } from "@/auth/organization-context";

export type ApiContext = {
  database: D1Database;
  user: AuthUser;
  organizationId: string;
};

export async function requireApiContext(request: Request, permission?: string): Promise<ApiContext | NextResponse> {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ message: "Требуется авторизация." }, { status: 401 });
  if (request.method !== "GET" && !hasSameOrigin(request)) {
    return NextResponse.json({ message: "Недопустимый источник запроса." }, { status: 403 });
  }

  const database = await ensureDomainData(user);
  const organizationContext = await resolveUserOrganizationContext(database, user.id);
  if (!organizationContext) return NextResponse.json({ message: "Пользователь не связан ни с одной активной организацией." }, { status: 403 });
  const requestedOrganization = request.headers.get("X-MMI-Organization");
  if (requestedOrganization && !organizationContext.organizations.some(item => item.id === requestedOrganization)) {
    return NextResponse.json({ message: "Подразделение недоступно." }, { status: 403 });
  }
  const organizationId = requestedOrganization || organizationContext.currentOrganization.id;
  if (permission) {
    const allowed = await database.prepare(`SELECT 1 AS allowed
      FROM memberships
      JOIN role_permissions ON role_permissions.role_id = memberships.role_id
      WHERE memberships.organization_id = ? AND memberships.user_id = ?
        AND memberships.status = 'active' AND role_permissions.permission_code = ?
      LIMIT 1`).bind(organizationId, user.id, permission).first();
    if (!allowed) return NextResponse.json({ message: "Недостаточно прав для выполнения операции." }, { status: 403 });
  }

  return { database, user, organizationId };
}

export function isApiError(value: ApiContext | NextResponse): value is NextResponse {
  return value instanceof NextResponse;
}

export async function readJsonObject(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const value: unknown = await request.json();
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

export function badRequest(message = "Проверьте заполнение обязательных полей.") {
  return NextResponse.json({ message }, { status: 400 });
}

export function conflict(message: string) {
  return NextResponse.json({ message }, { status: 409 });
}

export function serverError(error: unknown) {
  console.error(error);
  return NextResponse.json({ message: "Не удалось выполнить операцию. Повторите попытку." }, { status: 500 });
}

function hasSameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  return !origin || origin === new URL(request.url).origin;
}
