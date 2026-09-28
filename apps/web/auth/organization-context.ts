import { cookies } from "next/headers";

const ORGANIZATION_COOKIE = "mmi_organization";

export type OrganizationOption = { id: string; name: string };
export type OrganizationContext = { organizations: OrganizationOption[]; currentOrganization: OrganizationOption };

export async function resolveUserOrganizationContext(database: D1Database, userId: string): Promise<OrganizationContext | null> {
  const organizations = await listUserOrganizations(database, userId);
  if (!organizations.length) return null;
  const cookieStore = await cookies();
  const requestedId = cookieStore.get(ORGANIZATION_COOKIE)?.value;
  const currentOrganization = organizations.find((organization) => organization.id === requestedId) ?? organizations[0]!;
  return { organizations, currentOrganization };
}

export async function listUserOrganizations(database: D1Database, userId: string): Promise<OrganizationOption[]> {
  const result = await database.prepare(`SELECT organizations.id, organizations.name
    FROM organizations
    JOIN memberships ON memberships.organization_id = organizations.id
    WHERE memberships.user_id = ? AND memberships.status = 'active' AND organizations.status = 'active'
    ORDER BY CASE organizations.id WHEN 'ORG-001' THEN 0 WHEN 'ORG-002' THEN 1 WHEN 'ORG-003' THEN 2 ELSE 3 END, organizations.name`)
    .bind(userId).all<OrganizationOption>();
  return result.results;
}

export function createOrganizationCookie(organizationId: string, secure: boolean) {
  return `${ORGANIZATION_COOKIE}=${encodeURIComponent(organizationId)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=43200${secure ? "; Secure" : ""}`;
}

export function clearOrganizationCookie(secure: boolean) {
  return `${ORGANIZATION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? "; Secure" : ""}`;
}
