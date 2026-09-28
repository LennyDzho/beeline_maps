import type { SkillInput, SkillRecord } from "../../admin/skill-data";

export class SkillError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409) { super(message); }
}

export async function listSkills(database: D1Database): Promise<SkillRecord[]> {
  const rows = await database.prepare(`SELECT s.id, s.name, s.description, s.active,
    (SELECT COUNT(*) FROM worker_skills ws JOIN workers w ON w.id = ws.worker_id
      WHERE ws.skill_id = s.id) AS worker_count,
    (SELECT COUNT(DISTINCT wt.id) FROM work_type_version_skills vs
      JOIN work_type_versions v ON v.id = vs.work_type_version_id JOIN work_types wt ON wt.id = v.work_type_id
      WHERE vs.skill_id = s.id) AS work_type_count
    FROM skills s ORDER BY s.active DESC, s.name, s.id`).all<{ id: string; name: string; description: string; active: number; worker_count: number; work_type_count: number }>();
  return rows.results.map((row) => ({ id: row.id, name: row.name, description: row.description, active: Boolean(row.active), workerCount: row.worker_count, workTypeCount: row.work_type_count }));
}

export async function saveSkill(database: D1Database, organizationId: string, input: SkillInput, id?: string): Promise<SkillRecord> {
  const name = input.name.normalize("NFKC").trim().replace(/\s+/gu, " ");
  const description = input.description.trim();
  if (!name || name.length > 200 || description.length > 2000) throw new SkillError("Укажите название до 200 символов и описание до 2000 символов.", 400);
  const items = await listSkills(database);
  const current = id ? items.find((item) => item.id === id) : undefined;
  if (id && !current) throw new SkillError("Навык не найден.", 404);
  const normalized = (value: string) => value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("ru-RU");
  if (items.some((item) => item.id !== id && normalized(item.name) === normalized(name))) throw new SkillError("Навык с таким названием уже существует в справочнике.", 409);
  if (current?.active && !input.active && (current.workerCount || current.workTypeCount)) throw new SkillError("Нельзя отключить используемый навык: он связан с исполнителями или версиями типов работ.", 409);
  const recordId = current?.id ?? `SKILL-${crypto.randomUUID()}`;
  if (current) {
    const result = await database.prepare(`UPDATE skills SET name = ?, description = ?, active = ?
      WHERE id = ? AND (active = 0 OR ? = 1 OR (
        NOT EXISTS (SELECT 1 FROM worker_skills WHERE skill_id = skills.id)
        AND NOT EXISTS (SELECT 1 FROM work_type_version_skills WHERE skill_id = skills.id)))`)
      .bind(name, description, input.active ? 1 : 0, recordId, input.active ? 1 : 0).run();
    if (result.meta.changes !== 1) throw new SkillError("Запись уже используется или изменилась. Обновите справочник и повторите попытку.", 409);
  } else {
    await database.prepare("INSERT INTO skills (id, organization_id, name, description, active) VALUES (?, ?, ?, ?, ?)")
      .bind(recordId, organizationId, name, description, input.active ? 1 : 0).run();
  }
  return { id: recordId, name, description, active: input.active, workerCount: current?.workerCount ?? 0, workTypeCount: current?.workTypeCount ?? 0 };
}

/** Stable IDs take precedence over display names, including after renaming. */
export async function resolveSkillIds(database: D1Database, _organizationId: string, selection: { ids?: string[]; names: string[] }, retainedIds: string[] = []): Promise<string[] | null> {
  const rows = await database.prepare("SELECT id, name, active FROM skills").all<{ id: string; name: string; active: number }>();
  const selected = selection.ids ? selection.ids.map((id) => rows.results.find((item) => item.id === id)) : selection.names.map((name) => rows.results.find((item) => item.name === name));
  if (!selected.length || selected.some((item) => !item || (!item.active && !retainedIds.includes(item.id)))) return null;
  const ids = selected.map((item) => item!.id);
  return new Set(ids).size === ids.length ? ids : null;
}

export async function workerSkillIds(database: D1Database, workerId: string): Promise<string[]> {
  const result = await database.prepare("SELECT skill_id FROM worker_skills WHERE worker_id = ? ORDER BY skill_id").bind(workerId).all<{ skill_id: string }>();
  return result.results.map((row) => row.skill_id);
}

export function updateWorkerSkills(database: D1Database, workerId: string, ids: string[], confirmedAt: string): D1PreparedStatement[] {
  if (!ids.length) throw new SkillError("Выберите хотя бы один навык.", 400);
  // Preserve each retained skill's level and confirmation date.
  return [
    database.prepare(`DELETE FROM worker_skills WHERE worker_id = ? AND skill_id NOT IN (${ids.map(() => "?").join(",")})`).bind(workerId, ...ids),
    ...ids.map((id) => database.prepare("INSERT OR IGNORE INTO worker_skills (worker_id, skill_id, level, confirmed_at) VALUES (?, ?, 'qualified', ?)").bind(workerId, id, confirmedAt)),
  ];
}
