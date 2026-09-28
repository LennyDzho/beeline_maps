import type { QualificationInput, QualificationRecord } from "../../admin/qualification-data";

export class QualificationError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409) { super(message); }
}

export async function listQualifications(database: D1Database): Promise<QualificationRecord[]> {
  const rows = await database.prepare(`SELECT q.id, q.code, q.name, q.description, q.active,
    (SELECT COUNT(*) FROM worker_qualifications wq JOIN workers w ON w.id = wq.worker_id
      WHERE wq.qualification_id = q.id) AS worker_count,
    (SELECT COUNT(DISTINCT wt.id) FROM work_type_version_qualifications vq
      JOIN work_type_versions v ON v.id = vq.work_type_version_id JOIN work_types wt ON wt.id = v.work_type_id
      WHERE vq.qualification_id = q.id) AS work_type_count
    FROM qualifications q ORDER BY q.active DESC, q.name, q.id`).all<{ id: string; code: string; name: string; description: string; active: number; worker_count: number; work_type_count: number }>();
  return rows.results.map((row) => ({ id: row.id, code: row.code, name: row.name, description: row.description, active: Boolean(row.active), workerCount: row.worker_count, workTypeCount: row.work_type_count }));
}

export async function saveQualification(database: D1Database, organizationId: string, input: QualificationInput, id?: string): Promise<QualificationRecord> {
  const name = input.name.trim().replace(/\s+/gu, " ");
  const description = input.description.trim();
  if (!name || name.length > 200 || description.length > 2000) throw new QualificationError("Укажите название до 200 символов и описание до 2000 символов.", 400);
  const items = await listQualifications(database);
  const current = id ? items.find((item) => item.id === id) : undefined;
  if (id && !current) throw new QualificationError("Допуск или квалификация не найдены.", 404);
  const normalized = (value: string) => value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("ru-RU");
  if (items.some((item) => item.id !== id && normalized(item.name) === normalized(name))) throw new QualificationError("Допуск или квалификация с таким названием уже существуют в справочнике.", 409);
  if (current?.active && !input.active && (current.workerCount || current.workTypeCount)) {
    throw new QualificationError("Нельзя отключить используемый допуск: он связан с исполнителями или версиями типов работ. Существующие связи сохранены.", 409);
  }
  const recordId = current?.id ?? `QUAL-${crypto.randomUUID()}`;
  if (current) {
    // Keep ID, code, validity policy and all referencing records unchanged.
    const result = await database.prepare(`UPDATE qualifications SET name = ?, description = ?, active = ?
      WHERE id = ? AND (active = 0 OR ? = 1 OR (
        NOT EXISTS (SELECT 1 FROM worker_qualifications WHERE qualification_id = qualifications.id)
        AND NOT EXISTS (SELECT 1 FROM work_type_version_qualifications WHERE qualification_id = qualifications.id)))`)
      .bind(name, description, input.active ? 1 : 0, recordId, input.active ? 1 : 0).run();
    if (result.meta.changes !== 1) throw new QualificationError("Запись уже используется или изменилась. Обновите справочник и повторите попытку.", 409);
  } else {
    await database.prepare("INSERT INTO qualifications (id, organization_id, code, name, description, validity_required, active) VALUES (?, ?, ?, ?, ?, 0, ?)")
      .bind(recordId, organizationId, recordId, name, description, input.active ? 1 : 0).run();
  }
  return { id: recordId, code: current?.code ?? recordId, name, description, active: input.active, workerCount: current?.workerCount ?? 0, workTypeCount: current?.workTypeCount ?? 0 };
}

/** IDs survive renaming; names remain supported for older clients. Inactive links may be retained, never newly assigned. */
export async function resolveQualificationIds(database: D1Database, _organizationId: string, selection: { ids?: string[]; names: string[] }, retainedIds: string[] = []): Promise<string[] | null> {
  const rows = await database.prepare("SELECT id, name, active FROM qualifications").all<{ id: string; name: string; active: number }>();
  const selected = selection.ids
    ? selection.ids.map((id) => rows.results.find((item) => item.id === id))
    : selection.names.map((name) => rows.results.find((item) => item.name === name));
  if (!selected.length || selected.some((item) => !item || (!item.active && !retainedIds.includes(item.id)))) return null;
  const ids = selected.map((item) => item!.id);
  return new Set(ids).size === ids.length ? ids : null;
}

export async function workerQualificationIds(database: D1Database, workerId: string): Promise<string[]> {
  const result = await database.prepare("SELECT qualification_id FROM worker_qualifications WHERE worker_id = ? ORDER BY qualification_id")
    .bind(workerId).all<{ qualification_id: string }>();
  return result.results.map((row) => row.qualification_id);
}

export function updateWorkerQualifications(database: D1Database, workerId: string, ids: string[], warning: boolean): D1PreparedStatement[] {
  if (!ids.length) throw new QualificationError("Выберите хотя бы один допуск или квалификацию.", 400);
  // Only explicitly removed links are deleted. Existing document numbers,
  // expiry dates and individual statuses are not overwritten by a form save.
  return [
    database.prepare(`DELETE FROM worker_qualifications WHERE worker_id = ? AND qualification_id NOT IN (${ids.map(() => "?").join(",")})`).bind(workerId, ...ids),
    ...ids.map((id) => database.prepare("INSERT OR IGNORE INTO worker_qualifications (worker_id, qualification_id, status) VALUES (?, ?, ?)").bind(workerId, id, warning ? "expiring" : "valid")),
  ];
}
