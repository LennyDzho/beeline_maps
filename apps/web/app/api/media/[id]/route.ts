import { isApiError, requireApiContext } from "@/app/api/_shared";
import { MobileError, json } from "@/app/lib/server/mobile/context";
import { readMedia } from "@/app/lib/server/mobile/media";
export const dynamic = "force-dynamic";
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireApiContext(request, "reports.view");
    if (isApiError(ctx)) return ctx;
    return await readMedia(request, ctx.database, (await context.params).id, ctx.organizationId);
  } catch (error) { return json({ message: error instanceof MobileError ? error.message : "Не удалось открыть материал." }, error instanceof MobileError ? error.status : 500); }
}
