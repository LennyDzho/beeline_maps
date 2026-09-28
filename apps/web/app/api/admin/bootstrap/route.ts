import { NextResponse } from "next/server";
import { isApiError, requireApiContext, serverError } from "@/app/api/_shared";
import { listAdminUsers, listRoles, listWorkSchedules, listWorkTypes } from "@/app/api/admin/_data";
import { loadPlanningSettings } from "@/app/lib/server/planning/settings-storage";
import { listQualifications } from "@/app/lib/server/qualifications";
import { listSkills } from "@/app/lib/server/skills";

import { listWorkCategories, listEquipmentItems } from "@/app/lib/server/work-catalog";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const context = await requireApiContext(request, "admin.users");
    if (isApiError(context)) return context;
    const [users, roles, workTypes, workSchedules, settings, planningSettings, qualifications, skills, workCategories, equipmentItems] = await Promise.all([
      listAdminUsers(context.database, context.organizationId),
      listRoles(context.database, context.organizationId),
      listWorkTypes(context.database),
      listWorkSchedules(context.database, context.organizationId),
      context.database.prepare("SELECT timezone, office_address FROM organizations WHERE id = ?").bind(context.organizationId).first<{ timezone: string; office_address: string }>(),
      loadPlanningSettings(context.database),
      listQualifications(context.database),
      listSkills(context.database),
      listWorkCategories(context.database),
      listEquipmentItems(context.database),
    ]);
    return NextResponse.json({ users, roles, workTypes, workSchedules, qualifications, skills, workCategories, equipmentItems, settings: {
      timezone: settings?.timezone ?? "Europe/Moscow",
      officeAddress: settings?.office_address ?? "",
      ...planningSettings,
    } });
  } catch (error) { return serverError(error); }
}
