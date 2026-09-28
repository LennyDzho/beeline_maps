import { NextResponse } from "next/server";
import { badRequest, isApiError, readJsonObject, requireApiContext, serverError } from "@/app/api/_shared";
import type { DispatcherNotification, NotificationFeed } from "@/app/lib/dispatcher-notifications";

type Row = { sequence: number; work_order_id: string; order_number: string; kind: "status" | "problem"; detail: string; created_at: string; read_at: string | null };
const select = `SELECT n.*, w.number AS order_number, r.read_at FROM dispatcher_notifications n
  JOIN work_orders w ON w.id=n.work_order_id AND w.organization_id=n.organization_id
  LEFT JOIN dispatcher_notification_reads r ON r.sequence=n.sequence AND r.user_id=? WHERE n.organization_id=?`;
const statusLabels: Record<string, string> = { new: "Новая", assigned: "Назначена", en_route: "В пути", in_progress: "В работе", paused: "Приостановлена", completed: "Завершена", confirmed: "Подтверждена", cancelled: "Отменена" };
const present = (row: Row): DispatcherNotification => ({ sequence: row.sequence, orderId: row.work_order_id, kind: row.kind,
  title: `Заявка № ${row.order_number} · ${row.kind === "problem" ? "Проблема" : statusLabels[row.detail] ?? row.detail}`,
  detail: row.kind === "problem" ? row.detail : `Статус: ${statusLabels[row.detail] ?? row.detail}`, createdAt: row.created_at, read: Boolean(row.read_at) });

export async function GET(request: Request) {
  try {
    const ctx = await requireApiContext(request, "planning.manage"); if (isApiError(ctx)) return ctx;
    const before = new URL(request.url).searchParams.get("before");
    if (before !== null && (!/^\d+$/u.test(before) || !Number.isSafeInteger(Number(before)))) return badRequest();
    const [latest, cursor, items, unread, zone] = await Promise.all([
      ctx.database.prepare("SELECT COALESCE(MAX(sequence),0) AS value FROM dispatcher_notifications WHERE organization_id=?").bind(ctx.organizationId).first<{ value: number }>(),
      ctx.database.prepare("SELECT delivered_sequence AS value FROM dispatcher_notification_cursors WHERE user_id=? AND organization_id=?").bind(ctx.user.id, ctx.organizationId).first<{ value: number }>(),
      ctx.database.prepare(`${select} ${before === null ? "" : "AND n.sequence<?"} ORDER BY n.sequence DESC LIMIT 50`).bind(ctx.user.id, ctx.organizationId, ...(before === null ? [] : [Number(before)])).all<Row>(),
      ctx.database.prepare(`SELECT COUNT(*) AS value FROM dispatcher_notifications n WHERE n.organization_id=? AND NOT EXISTS (SELECT 1 FROM dispatcher_notification_reads r WHERE r.sequence=n.sequence AND r.user_id=?)`).bind(ctx.organizationId, ctx.user.id).first<{ value: number }>(),
      ctx.database.prepare("SELECT timezone FROM organizations WHERE id=?").bind(ctx.organizationId).first<{ timezone: string }>(),
    ]);
    const start = cursor?.value ?? latest!.value;
    const pending = await ctx.database.prepare(`${select} AND n.sequence>? ORDER BY n.sequence LIMIT 50`).bind(ctx.user.id, ctx.organizationId, start).all<Row>();
    const result: NotificationFeed = { organizationId: ctx.organizationId, timezone: zone!.timezone, latest: latest!.value, cursor: start, initialized: Boolean(cursor), unread: unread!.value,
      items: items.results.map(present), pending: pending.results.map(present), nextBefore: items.results.length === 50 ? items.results.at(-1)!.sequence : null };
    return NextResponse.json(result);
  } catch (error) { return serverError(error); }
}

export async function PUT(request: Request) {
  try {
    const ctx = await requireApiContext(request, "planning.manage"); if (isApiError(ctx)) return ctx;
    const body = await readJsonObject(request);
    if (!body || !["read", "read_all", "delivered"].includes(String(body.action))) return badRequest();
    if (body.action === "delivered") {
      if (!Number.isSafeInteger(body.sequence) || Number(body.sequence) < 0) return badRequest();
      if (body.sequence !== 0 && !await ctx.database.prepare("SELECT 1 FROM dispatcher_notifications WHERE sequence=? AND organization_id=?").bind(body.sequence, ctx.organizationId).first()) return badRequest("Уведомление недоступно.");
      await ctx.database.prepare(`INSERT INTO dispatcher_notification_cursors (user_id,organization_id,delivered_sequence) VALUES (?,?,?)
        ON CONFLICT(user_id,organization_id) DO UPDATE SET delivered_sequence=MAX(delivered_sequence,excluded.delivered_sequence)`)
        .bind(ctx.user.id, ctx.organizationId, body.sequence).run();
    } else if (body.action === "read_all") {
      if (!Number.isSafeInteger(body.throughSequence) || Number(body.throughSequence) < 0) return badRequest();
      await ctx.database.batch([ctx.database.prepare(`INSERT OR IGNORE INTO dispatcher_notification_reads (user_id,sequence,read_at)
        SELECT ?,sequence,? FROM dispatcher_notifications WHERE organization_id=? AND sequence<=?`)
        .bind(ctx.user.id, new Date().toISOString(), ctx.organizationId, body.throughSequence),
        ctx.database.prepare(`INSERT INTO dispatcher_notification_cursors (user_id,organization_id,delivered_sequence)
          SELECT ?,?,COALESCE(MAX(sequence),0) FROM dispatcher_notifications WHERE organization_id=? AND sequence<=?
          ON CONFLICT(user_id,organization_id) DO UPDATE SET delivered_sequence=MAX(delivered_sequence,excluded.delivered_sequence)`)
          .bind(ctx.user.id, ctx.organizationId, ctx.organizationId, body.throughSequence)]);
    } else {
      if (!Array.isArray(body.sequences) || body.sequences.length > 100 || body.sequences.some(value => !Number.isSafeInteger(value) || value < 1)) return badRequest();
      const now = new Date().toISOString();
      if (body.sequences.length) await ctx.database.batch([...new Set(body.sequences)].map(sequence => ctx.database.prepare(`INSERT OR IGNORE INTO dispatcher_notification_reads (user_id,sequence,read_at)
        SELECT ?,sequence,? FROM dispatcher_notifications WHERE sequence=? AND organization_id=?`).bind(ctx.user.id, now, sequence, ctx.organizationId)));
    }
    return NextResponse.json({ ok: true });
  } catch (error) { return serverError(error); }
}
