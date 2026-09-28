import type { MobileContext } from "./context";
import { MobileError } from "./errors";
import { assertMobileDataset, datasetVersionSql, ownOrder } from "./state";
import { loadReportRequirements, validateReportSections } from "../../report-requirements";

export function allowedTransition(from: string, to: string) {
  return (from === "assigned" && ["en_route", "in_progress"].includes(to)) ||
    ((from === "en_route" || from === "paused") && to === "in_progress") || (from === "in_progress" && to === "completed");
}
export async function executeCommand(ctx: MobileContext, body: Record<string, unknown>) {
  const { operationId, action } = body;
  if (typeof operationId !== "string" || !/^[a-zA-Z0-9-]{16,80}$/u.test(operationId) || typeof action !== "string") throw new MobileError(400, "Некорректная команда.");
  const datasetVersion = await assertMobileDataset(ctx.database, body.datasetVersion);
  const fingerprint = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(body))))).map(v => v.toString(16).padStart(2, "0")).join("");
  const existing = await previousCommand(ctx, operationId);
  if (existing) { if (existing.fingerprint !== fingerprint) throw new MobileError(409, "Идентификатор команды уже использован."); return { ok: true, replayed: true }; }
  const db = ctx.database;
  const now = new Date().toISOString();
  const statements: D1PreparedStatement[] = [];
  let condition = "1";
  let values: unknown[] = [];
  let entityId = ctx.workerId;
  if (action === "status" || action === "problem") {
    if (typeof body.visitId !== "string" || !Number.isInteger(body.revision)) throw new MobileError(400, "Не указана версия заявки.");
    const order = await ownOrder(ctx, body.visitId);
    if (order.revision !== body.revision) throw revisionConflict();
    entityId = order.id;
    condition = `EXISTS (SELECT 1 FROM work_orders o WHERE o.id = ? AND o.organization_id = ? AND o.assignee_worker_id = ? AND o.revision = ? AND o.status = ?)`;
    values = [order.id, ctx.organizationId, ctx.workerId, body.revision, order.status];
    if (action === "status") {
      if (typeof body.status !== "string" || !allowedTransition(order.status, body.status)) throw new MobileError(409, "Статус уже изменён. Обновите расписание.");
      condition += ` AND EXISTS (SELECT 1 FROM workers WHERE id = ? AND shift_status = 'on_shift')
        AND NOT EXISTS (SELECT 1 FROM work_orders WHERE assignee_worker_id = ? AND id <> ? AND status IN ('en_route', 'in_progress'))`;
      values.push(ctx.workerId, ctx.workerId, order.id);
      let autoAccepted = false;
      if (body.status === "completed") {
        if (typeof body.report !== "string" || body.report.trim().length < 10 || body.report.length > 2000) throw new MobileError(400, "Опишите результат работы: от 10 до 2000 символов.");
        if (!Array.isArray(body.mediaIds) || body.mediaIds.length < 1 || body.mediaIds.length > 8 || body.mediaIds.some(id => typeof id !== "string") || new Set(body.mediaIds).size !== body.mediaIds.length) throw new MobileError(400, "Прикрепите от 1 до 8 фото или видео.");
        const report = await db.prepare(`SELECT id FROM work_reports WHERE work_order_id = ? AND performer_worker_id = ? AND status = 'draft' ORDER BY revision DESC LIMIT 1`).bind(order.id, ctx.workerId).first<{ id: string }>();
        if (!report) throw new MobileError(409, "Сначала загрузите материалы отчёта.");
        const requirements=(await loadReportRequirements(db,ctx.organizationId,[order.id])).get(order.id) ?? [];
        const selectedMedia=await db.prepare("SELECT kind FROM report_media WHERE report_id=? AND upload_status='uploaded' AND id IN (SELECT value FROM json_each(?))")
          .bind(report.id,JSON.stringify(body.mediaIds)).all<{kind:string}>();
        let sections;
        try { sections=validateReportSections(requirements,body.reportValues,selectedMedia.results); }
        catch(error) { throw new MobileError(400,error instanceof Error ? error.message : "Проверьте отчёт по всем работам."); }
        autoAccepted = sections.length > 0 && sections.every(section => section.verificationMode === "automatic");
        condition += ` AND EXISTS (SELECT 1 FROM work_reports WHERE id = ? AND status = 'draft')
          AND (SELECT COUNT(*) FROM report_media WHERE report_id = ? AND upload_status = 'uploaded' AND id IN (${body.mediaIds.map(() => "?").join(",")})) = ?`;
        values.push(report.id, report.id, ...body.mediaIds, body.mediaIds.length);
        statements.push(db.prepare(`UPDATE work_reports SET comment = ?, field_values_json = ?, status = ?, submitted_at = ?, accepted_at = ?, updated_at = ? WHERE id = ?`).bind(body.report.trim(), JSON.stringify({schema:1,sections}), autoAccepted ? "accepted" : "submitted", now, autoAccepted ? now : null, now, report.id));
        // Unselected drafts remain private and cannot appear in a submitted report.
        statements.push(db.prepare(`UPDATE report_media SET upload_status = 'deleted' WHERE report_id = ? AND id NOT IN (${body.mediaIds.map(() => "?").join(",")})`).bind(report.id, ...body.mediaIds));
      }
      statements.push(db.prepare(`UPDATE work_orders SET status = ?, completed_at = ?, updated_at = ? WHERE id = ?`).bind(body.status, body.status === "completed" ? now : null, now, order.id));
      statements.push(db.prepare(`INSERT INTO work_order_status_history (id, work_order_id, from_status, to_status, changed_by_user_id, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .bind(crypto.randomUUID(), order.id, order.status, body.status, ctx.user.id, body.status === "completed" ? "Отчёт отправлен из Android" : order.status === "paused" ? "Исполнитель продолжил работу" : "Изменено исполнителем в Android", now));
      if (autoAccepted) {
        // Completion and acceptance are committed together. System acceptance is
        // recorded separately from the performer's submission, without a fictitious reviewer.
        statements.push(db.prepare("UPDATE work_orders SET status = 'confirmed', updated_at = ? WHERE id = ?").bind(now, order.id));
        statements.push(db.prepare(`INSERT INTO work_order_status_history (id, work_order_id, from_status, to_status, changed_by_user_id, reason, created_at)
          VALUES (?, ?, 'completed', 'confirmed', NULL, 'Отчёт принят автоматически по настройкам всех работ заявки', ?)`)
          .bind(crypto.randomUUID(), order.id, now));
        statements.push(db.prepare(`INSERT INTO audit_events (id, organization_id, actor_user_id, entity_type, entity_id, action, payload_json, created_at)
          VALUES (?, ?, NULL, 'work_order', ?, 'report.auto_accept', ?, ?)`)
          .bind(crypto.randomUUID(), ctx.organizationId, order.id, JSON.stringify({ operationId }), now));
      }
    } else {
      if (!["assigned", "en_route", "in_progress"].includes(order.status)) throw new MobileError(409, "Заявка уже приостановлена или закрыта. Обновите расписание.");
      if (typeof body.reason !== "string" || body.reason.trim().length < 1 || body.reason.length > 100 || typeof body.details !== "string" || body.details.trim().length < 5 || body.details.length > 1000) throw new MobileError(400, "Добавьте описание проблемы.");
      statements.push(db.prepare(`INSERT INTO mobile_issues (id, work_order_id, worker_id, reason, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)`).bind(crypto.randomUUID(), order.id, ctx.workerId, body.reason.trim(), body.details.trim(), now));
      statements.push(db.prepare("UPDATE work_orders SET status = 'paused', updated_at = ? WHERE id = ?").bind(now, order.id));
      statements.push(db.prepare(`INSERT INTO work_order_status_history (id, work_order_id, from_status, to_status, changed_by_user_id, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .bind(crypto.randomUUID(), order.id, order.status, "paused", ctx.user.id, `Приостановлена: ${body.reason.trim()} — ${body.details.trim()}`, now));
    }
  } else if (action === "shift") {
    if (typeof body.onShift !== "boolean") throw new MobileError(400, "Укажите состояние смены.");
    if (!body.onShift) { condition = "NOT EXISTS (SELECT 1 FROM work_orders WHERE assignee_worker_id = ? AND status IN ('en_route', 'in_progress'))"; values = [ctx.workerId]; }
    statements.push(db.prepare("UPDATE workers SET shift_status = ?, updated_at = ? WHERE id = ?").bind(body.onShift ? "on_shift" : "off_shift", now, ctx.workerId));
  } else if (action === "read") {
    if (!Array.isArray(body.ids) || body.ids.length > 150 || body.ids.some(id => typeof id !== "string" || id.length > 80)) throw new MobileError(400, "Некорректные уведомления.");
    statements.push(db.prepare(`INSERT OR IGNORE INTO mobile_notice_reads (user_id, event_id, read_at)
      SELECT ?, h.id, ? FROM work_order_status_history h JOIN work_orders o ON o.id = h.work_order_id
      WHERE h.id IN (SELECT value FROM json_each(?)) AND o.assignee_worker_id = ? AND o.organization_id = ?`).bind(ctx.user.id, now, JSON.stringify(body.ids), ctx.workerId, ctx.organizationId));
  } else throw new MobileError(400, "Неизвестная команда.");
  // Recheck session/assignment authorization inside the write transaction as well.
  condition += ` AND EXISTS (SELECT 1 FROM workers w JOIN users u ON u.id = w.user_id
    JOIN memberships m ON m.user_id = u.id AND m.organization_id = w.organization_id
    JOIN role_permissions rp ON rp.role_id = m.role_id AND rp.permission_code = 'mobile.execute'
    WHERE w.id = ? AND w.user_id = ? AND w.organization_id = ? AND w.active = 1 AND u.status = 'active' AND m.status = 'active')`;
  values.push(ctx.workerId, ctx.user.id, ctx.organizationId);
  condition += ` AND ${datasetVersionSql} = ?`;
  values.push(datasetVersion);
  statements.unshift(db.prepare(`INSERT INTO mobile_commands (user_id, operation_id, fingerprint, accepted, created_at) VALUES (?, ?, ?, CASE WHEN ${condition} THEN 1 ELSE 0 END, ?)`)
    .bind(ctx.user.id, operationId, fingerprint, ...values, now));
  statements.push(db.prepare(`INSERT INTO audit_events (id, organization_id, actor_user_id, entity_type, entity_id, action, payload_json, created_at) VALUES (?, ?, ?, 'mobile', ?, ?, ?, ?)`)
    .bind(crypto.randomUUID(), ctx.organizationId, ctx.user.id, entityId, `mobile.${action}`, JSON.stringify({ operationId, status: action === "problem" ? "paused" : body.status ?? null }), now));
  try { await db.batch(statements); }
  catch (error) {
    await assertMobileDataset(db, datasetVersion);
    const previous = await previousCommand(ctx, operationId);
    if (previous?.fingerprint === fingerprint) return { ok: true, replayed: true };
    if (String(error).includes("mobile_command_precondition") || previous) {
      if (!previous && (action === "status" || action === "problem")) {
        const current = await ownOrder(ctx, entityId);
        if (current.revision !== body.revision) throw revisionConflict();
      }
      throw new MobileError(409, "Данные изменились: обновите расписание и проверьте смену и активный визит.");
    }
    throw error;
  }
  return { ok: true, replayed: false };
}
function revisionConflict() {
  return new MobileError(409, "Версия заявки изменилась. Действие не принято сервером и сохранено на устройстве.", "revision_conflict");
}
function previousCommand(ctx: MobileContext, operationId: string) {
  return ctx.database.prepare("SELECT fingerprint FROM mobile_commands WHERE user_id = ? AND operation_id = ?").bind(ctx.user.id, operationId).first<{ fingerprint: string }>();
}
