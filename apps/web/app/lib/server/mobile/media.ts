import { env } from "cloudflare:workers";
import { MobileError, type MobileContext } from "./context";
import { assertMobileDataset, datasetVersionSql, ownOrder } from "./state";

export const MEDIA_LIMITS = { maxFiles: 8, photoBytes: 12 * 1024 * 1024, videoBytes: 32 * 1024 * 1024 };
export const MEDIA_TYPES = ["image/jpeg", "image/png", "image/webp", "video/mp4", "video/webm"];
export function mediaSignatureMatches(type: string, bytes: Uint8Array) {
  const ascii = (start: number, end: number) => String.fromCharCode(...bytes.slice(start, end));
  if (type === "image/jpeg") return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (type === "image/png") return [137,80,78,71,13,10,26,10].every((b,i) => bytes[i] === b);
  if (type === "image/webp") return ascii(0,4) === "RIFF" && ascii(8,12) === "WEBP";
  if (type === "video/mp4") return ascii(4,8) === "ftyp";
  if (type === "video/webm") return [0x1a,0x45,0xdf,0xa3].every((b,i) => bytes[i] === b);
  return false;
}
export function checkedStream(type: string, size: number) {
  let count = 0;
  let header = new Uint8Array(0);
  let checked = false;
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      count += chunk.byteLength;
      if (count > size) throw new MobileError(413, "Размер файла превышает заявленный.");
      if (!checked) {
        const needed = Math.min(16 - header.length, chunk.length);
        const next = new Uint8Array(header.length + needed); next.set(header); next.set(chunk.subarray(0, needed), header.length); header = next;
        if (header.length >= 12) { if (!mediaSignatureMatches(type, header)) throw new MobileError(415, "Файл не соответствует формату фото или видео."); checked = true; }
      }
      controller.enqueue(chunk);
    },
    flush() { if (count !== size || !checked) throw new MobileError(400, "Файл загружен не полностью."); },
  });
}
export async function uploadMedia(ctx: MobileContext, request: Request, orderId: string, mediaId: string) {
  const datasetVersion = await assertMobileDataset(ctx.database, request.headers.get("x-dataset-version"));
  if (!env.MEDIA) throw new MobileError(503, "Хранилище материалов не подключено.");
  const order = await ownOrder(ctx, orderId);
  if (order.status !== "in_progress") throw new MobileError(409, "Материалы можно отправить во время выполнения работы.");
  if (!/^[a-f0-9-]{36}$/u.test(mediaId)) throw new MobileError(400, "Некорректный идентификатор файла.");
  const mime = request.headers.get("content-type") ?? "";
  const size = Number(request.headers.get("content-length"));
  const checksum = request.headers.get("x-content-sha256") ?? "";
  const kind = mime.startsWith("video/") ? "video" : "photo";
  if (!MEDIA_TYPES.includes(mime)) throw new MobileError(415, "Поддерживаются JPEG, PNG, WebP, MP4 и WebM.");
  if (!Number.isInteger(size) || size < 12 || size > (kind === "photo" ? MEDIA_LIMITS.photoBytes : MEDIA_LIMITS.videoBytes)) throw new MobileError(413, "Лимит: 12 МБ для фото, 32 МБ для видео.");
  if (!/^[a-f0-9]{64}$/u.test(checksum) || !request.body) throw new MobileError(400, "Не указана контрольная сумма файла.");
  let fileName: string;
  // eslint-disable-next-line no-control-regex -- Intentionally strip control characters from uploaded file names.
  try { fileName = decodeURIComponent(request.headers.get("x-file-name") ?? "").replace(/[\\/\x00-\x1f]/gu, "_").slice(0, 200); } catch { throw new MobileError(400, "Некорректное имя файла."); }
  if (!fileName) throw new MobileError(400, "Укажите имя файла.");
  const captured = request.headers.get("x-captured-at");
  const capturedAt = captured && !Number.isNaN(Date.parse(captured)) ? new Date(captured).toISOString() : null;
  const db = ctx.database;
  const now = new Date().toISOString();
  // A deterministic draft identity prevents duplicate reports on simultaneous uploads.
  const reportId = `MOBILE-${order.id}-${ctx.workerId}`;
  await db.prepare(`INSERT OR IGNORE INTO work_reports (id, work_order_id, performer_worker_id, revision, status, comment, field_values_json, created_at, updated_at)
    SELECT ?, o.id, ?, COALESCE((SELECT MAX(revision) FROM work_reports WHERE work_order_id = o.id), 0) + 1, 'draft', '', '{}', ?, ?
    FROM work_orders o WHERE o.id = ? AND o.assignee_worker_id = ? AND o.organization_id = ? AND o.status = 'in_progress' AND ${datasetVersionSql}=?`)
    .bind(reportId, ctx.workerId, now, now, order.id, ctx.workerId, ctx.organizationId, datasetVersion).run();
  const storageKey = `reports/${ctx.organizationId}/${reportId}/${mediaId}`;
  await db.prepare(`INSERT OR IGNORE INTO report_media (id, report_id, kind, category, storage_key, file_name, mime_type, size_bytes, checksum, upload_status, captured_at, created_at)
    SELECT ?, r.id, ?, 'result', ?, ?, ?, ?, ?, 'pending', ?, ? FROM work_reports r
    WHERE r.id = ? AND r.status = 'draft' AND ${datasetVersionSql}=? AND (SELECT COUNT(*) FROM report_media WHERE report_id = r.id AND upload_status IN ('pending', 'uploaded')) < 8`)
    .bind(mediaId, kind, storageKey, fileName, mime, size, checksum, capturedAt, now, reportId, datasetVersion).run();
  const row = await db.prepare("SELECT report_id, checksum, size_bytes, mime_type, upload_status FROM report_media WHERE id = ?").bind(mediaId)
    .first<{ report_id: string; checksum: string; size_bytes: number; mime_type: string; upload_status: string }>();
  if (!row) throw new MobileError(409, "Лимит — 8 материалов в отчёте, либо отчёт уже отправлен.");
  if (row.report_id !== reportId || row.checksum !== checksum || row.size_bytes !== size || row.mime_type !== mime || row.upload_status === "deleted") throw new MobileError(409, "Этот идентификатор файла уже занят.");
  if (row.upload_status === "uploaded") return { id: mediaId, uploaded: true };
  if (row.upload_status === "failed") {
    // A failed attempt releases its slot. A retry must reserve it again atomically.
    const reserved = await db.prepare(`UPDATE report_media SET upload_status = 'pending' WHERE id = ? AND upload_status = 'failed'
      AND (SELECT COUNT(*) FROM report_media WHERE report_id = ? AND upload_status IN ('pending', 'uploaded')) < 8
      AND EXISTS (SELECT 1 FROM work_reports WHERE id = ? AND status = 'draft') AND ${datasetVersionSql}=? RETURNING id`)
      .bind(mediaId, reportId, reportId, datasetVersion).first();
    if (!reserved) throw new MobileError(409, "Лимит — 8 материалов в отчёте, либо загрузка уже выполняется.");
  }
  const fixed = new FixedLengthStream(size);
  const copying = request.body.pipeThrough(checkedStream(mime, size)).pipeTo(fixed.writable);
  try {
    await Promise.all([copying, env.MEDIA.put(storageKey, fixed.readable, { sha256: checksum, httpMetadata: { contentType: mime } })]);
    const saved = await db.prepare(`UPDATE report_media SET upload_status = 'uploaded'
      WHERE id = ? AND upload_status <> 'deleted' AND EXISTS (SELECT 1 FROM work_reports r JOIN work_orders o ON o.id = r.work_order_id
        WHERE r.id = report_media.report_id AND r.status = 'draft' AND o.assignee_worker_id = ? AND o.organization_id = ? AND o.status = 'in_progress') AND ${datasetVersionSql}=? RETURNING id`)
      .bind(mediaId, ctx.workerId, ctx.organizationId, datasetVersion).first();
    if (!saved) throw new MobileError(409, "Назначение или отчёт изменились. Обновите данные.");
    return { id: mediaId, uploaded: true };
  } catch (error) {
    await db.prepare("UPDATE report_media SET upload_status = 'failed' WHERE id = ? AND upload_status = 'pending'").bind(mediaId).run();
    await assertMobileDataset(db, datasetVersion);
    if (error instanceof MobileError) throw error;
    throw new MobileError(400, "Не удалось принять файл. Проверьте формат, размер и повторите загрузку.");
  }
}
export async function readMedia(request: Request, database: D1Database, id: string, organizationId: string, workerId?: string) {
  const row = await database.prepare(`SELECT m.storage_key, m.mime_type, m.file_name FROM report_media m
    JOIN work_reports r ON r.id = m.report_id JOIN work_orders o ON o.id = r.work_order_id
    WHERE m.id = ? AND m.upload_status = 'uploaded' AND o.organization_id = ? ${workerId ? "AND o.assignee_worker_id = ?" : "AND r.status <> 'draft'"}`)
    .bind(id, organizationId, ...(workerId ? [workerId] : [])).first<{ storage_key: string; mime_type: string; file_name: string }>();
  if (!row || !env.MEDIA || row.storage_key.startsWith("demo/")) throw new MobileError(404, "Материал недоступен.");
  const object = await env.MEDIA.get(row.storage_key, { range: request.headers });
  if (!object) throw new MobileError(404, "Файл отсутствует в хранилище.");
  const headers = new Headers({ "Content-Type": row.mime_type, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff",
    "Accept-Ranges": "bytes", "ETag": object.httpEtag, "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(row.file_name)}` });
  const range = request.headers.has("range") ? object.range : undefined;
  if (range) { headers.set("Content-Range", `bytes ${range.offset}-${range.offset + range.length - 1}/${object.size}`); headers.set("Content-Length", String(range.length)); }
  else headers.set("Content-Length", String(object.size));
  return new Response(object.body, { status: range ? 206 : 200, headers });
}
