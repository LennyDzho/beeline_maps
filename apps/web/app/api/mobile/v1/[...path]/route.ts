import { env } from "cloudflare:workers";
import { createPasswordRecord, verifyPassword } from "@/auth/crypto";
import { deleteSession } from "@/auth/session";
import { MobileError, json, mobileLogin, objectBody, requireMobileContext } from "@/app/lib/server/mobile/context";
import { assertMobileDataset, datasetVersionSql, mobileState } from "@/app/lib/server/mobile/state";
import { executeCommand } from "@/app/lib/server/mobile/commands";
import { MEDIA_LIMITS, MEDIA_TYPES, readMedia, uploadMedia } from "@/app/lib/server/mobile/media";

export const dynamic = "force-dynamic";
async function handle(request: Request) {
  try {
    const url = new URL(request.url);
    const path = url.pathname.slice("/api/mobile/v1/".length).split("/").map(decodeURIComponent);
    const route = path.join("/");
    if (request.method === "GET" && route === "health") return json({ application: "Марш!", protocol: 1, mediaAvailable: Boolean(env.MEDIA), mediaLimits: MEDIA_LIMITS, mediaTypes: MEDIA_TYPES });
    if (request.method === "POST" && route === "auth/login") return json(await mobileLogin(await objectBody(request)));
    const ctx = await requireMobileContext(request, route === "auth/password" || route === "auth/logout");
    if (request.method === "GET" && route === "state") return json(await mobileState(ctx, url.searchParams.get("date")));
    if (request.method === "POST" && route === "auth/logout") { await deleteSession(ctx.token); return json({ ok: true }); }
    if (request.method === "POST" && route === "auth/password") {
      const body = await objectBody(request);
      if (typeof body.currentPassword !== "string" || typeof body.newPassword !== "string" || body.newPassword.length < 8 || body.newPassword.length > 128 || body.newPassword === body.currentPassword) throw new MobileError(400, "Укажите новый пароль: от 8 до 128 символов, отличающийся от старого.");
      const user = await ctx.database.prepare("SELECT password_salt, password_hash, password_iterations FROM users WHERE id = ?").bind(ctx.user.id).first<{ password_salt: string; password_hash: string; password_iterations: number }>();
      if (!user || !await verifyPassword(body.currentPassword, user.password_salt, user.password_hash, user.password_iterations)) throw new MobileError(400, "Текущий пароль неверен.");
      const record = await createPasswordRecord(body.newPassword);
      await ctx.database.batch([
        ctx.database.prepare("UPDATE users SET password_salt = ?, password_hash = ?, password_iterations = ?, must_change_password = 0, updated_at = ? WHERE id = ?").bind(record.salt, record.hash, record.iterations, new Date().toISOString(), ctx.user.id),
        ctx.database.prepare("DELETE FROM sessions WHERE user_id = ?").bind(ctx.user.id),
      ]);
      return json({ ok: true, signInAgain: true });
    }
    if (request.method === "POST" && route === "commands") return json(await executeCommand(ctx, await objectBody(request)));
    if (request.method === "PUT" && path[0] === "media" && path.length === 3) return json(await uploadMedia(ctx, request, path[1], path[2]));
    if (request.method === "DELETE" && path[0] === "media" && path.length === 3) {
      const datasetVersion = await assertMobileDataset(ctx.database, request.headers.get("x-dataset-version"));
      const removed = await ctx.database.prepare(`UPDATE report_media SET upload_status = 'deleted' WHERE id = ?
        AND ${datasetVersionSql}=?
        AND EXISTS (SELECT 1 FROM work_reports r JOIN work_orders o ON o.id = r.work_order_id
          WHERE r.id = report_media.report_id AND r.status = 'draft' AND o.id = ? AND o.assignee_worker_id = ? AND o.organization_id = ? AND o.status = 'in_progress') RETURNING id`)
        .bind(path[2], datasetVersion, path[1], ctx.workerId, ctx.organizationId).first();
      if (!removed) throw new MobileError(404, "Черновик материала недоступен.");
      return json({ ok: true });
    }
    if (request.method === "GET" && path[0] === "media" && path.length === 2) return await readMedia(request, ctx.database, path[1], ctx.organizationId, ctx.workerId);
    throw new MobileError(404, "Метод API не найден.");
  } catch (error) {
    if (error instanceof MobileError) return json({ message: error.message, code: error.code }, error.status);
    console.error("Mobile API error", error instanceof Error ? error.message : "unknown");
    return json({ message: "Ошибка сервера. Повторите попытку позже." }, 500);
  }
}
export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const DELETE = handle;
