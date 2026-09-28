import { NextResponse } from "next/server";
import { badRequest, isApiError, readJsonObject, requireApiContext, serverError } from "@/app/api/_shared";
import { listSkills, SkillError, saveSkill } from "@/app/lib/server/skills";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const context = await requireApiContext(request, "admin.settings");
    if (isApiError(context)) return context;
    return NextResponse.json({ items: await listSkills(context.database) });
  } catch (error) { return serverError(error); }
}

export const POST = (request: Request) => save(request, false);
export const PUT = (request: Request) => save(request, true);

async function save(request: Request, editing: boolean) {
  try {
    const context = await requireApiContext(request, "admin.settings");
    if (isApiError(context)) return context;
    const body = await readJsonObject(request);
    if (!body || typeof body.name !== "string" || typeof body.description !== "string" || typeof body.active !== "boolean"
      || (editing && (typeof body.id !== "string" || !body.id))) return badRequest();
    const item = await saveSkill(context.database, context.organizationId, { name: body.name, description: body.description, active: body.active }, editing ? body.id as string : undefined);
    return NextResponse.json({ item }, { status: editing ? 200 : 201 });
  } catch (error) {
    if (error instanceof SkillError) return NextResponse.json({ message: error.message }, { status: error.status });
    return serverError(error);
  }
}
