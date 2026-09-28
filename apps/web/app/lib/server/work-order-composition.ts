import { canonicalWorkName, mergeEquipmentRequirements, type EquipmentSnapshot } from "../work-catalog";
import { WorkCatalogError, listWorkCategories, loadWorkTypeCatalogMetadata } from "./work-catalog";
import { isPlannedDurationMinutes } from "../planned-duration";
import { parseEvidencePolicy } from "../report-requirements";

export type WorkComponent = { versionId: string; workTypeId: string; name: string; duration: number; isEmergency?: boolean };
export type WorkComposition = { categoryId: string | null; components: WorkComponent[]; duration: number; durationSource: string; equipment: EquipmentSnapshot[] };

/** Read snapshots, including the single-version fallback for pre-catalog orders. */
export async function loadOrderCompositions(db: D1Database, organizationId: string) {
  const [orders, components, equipment] = await Promise.all([
    db.prepare(`SELECT o.id, o.category_id, o.service_duration_minutes, o.duration_source,
      v.id AS version_id, v.work_type_id, v.planned_duration_minutes, v.is_emergency, t.name
      FROM work_orders o JOIN work_type_versions v ON v.id=o.work_type_version_id JOIN work_types t ON t.id=v.work_type_id
      WHERE o.organization_id=?`).bind(organizationId).all<{ id: string; category_id: string | null; service_duration_minutes: number | null; duration_source: string; version_id: string; work_type_id: string; planned_duration_minutes: number; is_emergency: number; name: string }>(),
    db.prepare(`SELECT c.*, v.work_type_id, v.planned_duration_minutes, v.is_emergency FROM work_order_work_types c
      JOIN work_orders o ON o.id=c.work_order_id JOIN work_type_versions v ON v.id=c.work_type_version_id
      WHERE o.organization_id=? ORDER BY c.sequence`).bind(organizationId)
      .all<{ work_order_id: string; work_type_version_id: string; work_type_id: string; name_snapshot: string; planned_duration_minutes: number; is_emergency: number }>(),
    db.prepare(`SELECT e.* FROM work_order_equipment e JOIN work_orders o ON o.id=e.work_order_id WHERE o.organization_id=?`)
      .bind(organizationId).all<{ work_order_id: string; equipment_id: string; quantity: number | null; name_snapshot: string; unit_snapshot: string; usage_snapshot: EquipmentSnapshot["usage"] }>(),
  ]);
  const result = new Map<string, WorkComposition>();
  for (const row of orders.results) {
    const saved = components.results.filter(item => item.work_order_id === row.id);
    result.set(row.id, { categoryId: row.category_id, duration: row.service_duration_minutes ?? row.planned_duration_minutes, durationSource: row.duration_source,
      components: saved.length ? saved.map(item => ({ versionId: item.work_type_version_id, workTypeId: item.work_type_id, name: item.name_snapshot, duration: item.planned_duration_minutes, isEmergency:Boolean(item.is_emergency) }))
        : [{ versionId: row.version_id, workTypeId: row.work_type_id, name: row.name, duration: row.planned_duration_minutes, isEmergency:Boolean(row.is_emergency) }],
      equipment: equipment.results.filter(item => item.work_order_id === row.id).map(item => ({ equipmentId: item.equipment_id, quantity: item.quantity, name: item.name_snapshot, unit: item.unit_snapshot, usage: item.usage_snapshot })),
    });
  }
  return result;
}

export async function resolveOrderComposition(db: D1Database, organizationId: string,
  payload: { work: string; categoryId?: string; workTypeIds?: string[]; serviceDurationMinutes?: number; durationSource?: string }, existing?: WorkComposition): Promise<WorkComposition> {
  const sameIds = existing && payload.workTypeIds?.length === existing.components.length
    && payload.workTypeIds.every((id, index) => id === existing.components[index].workTypeId);
  const sameLegacyName = existing && !payload.workTypeIds && canonicalWorkName(payload.work) === existing.components.map(item => item.name).join(" + ");
  const unchanged = existing && (sameIds || sameLegacyName) && (payload.categoryId === undefined || (payload.categoryId || null) === existing.categoryId);
  if (unchanged) {
    // A description/status edit must not silently upgrade immutable work versions.
    const duration = payload.serviceDurationMinutes ?? existing.duration;
    if (!isPlannedDurationMinutes(duration)) throw new WorkCatalogError("Проверьте общий норматив обслуживания.");
    if (existing.components.length === 1 && duration !== existing.duration) throw new WorkCatalogError("Норматив одиночной работы задаётся в справочнике ВК/HD.");
    if (duration !== existing.duration && !payload.durationSource?.trim()) throw new WorkCatalogError("Укажите источник общего норматива.");
    return { ...existing, duration, durationSource: payload.durationSource?.trim() || existing.durationSource };
  }
  const versions = await db.prepare(`SELECT v.id AS versionId, t.id AS workTypeId, t.name, v.planned_duration_minutes AS duration, v.is_emergency AS isEmergency
    FROM work_types t JOIN work_type_versions v ON v.work_type_id=t.id WHERE t.active=1
    AND v.status='published' AND v.version=(SELECT MAX(v2.version) FROM work_type_versions v2 WHERE v2.work_type_id=t.id AND v2.status='published')`)
    .all<WorkComponent>();
  const aliases = await db.prepare("SELECT alias, work_type_id FROM work_type_aliases").all<{ alias: string; work_type_id: string }>();
  const name = canonicalWorkName(payload.work).toLocaleLowerCase("ru");
  const ids = payload.workTypeIds ?? versions.results.filter(row => canonicalWorkName(row.name).toLocaleLowerCase("ru") === name
    || aliases.results.some(alias => alias.work_type_id === row.workTypeId && alias.alias === name)).map(row => row.workTypeId);
  if (!ids.length || new Set(ids).size !== ids.length) throw new WorkCatalogError("Выберите хотя бы один тип HD.");
  const selected = ids.map(id => versions.results.find(row => row.workTypeId === id));
  if (selected.some(item => !item)) throw new WorkCatalogError("Выбранный тип HD не найден в справочнике.");
  const chosen = (selected as WorkComponent[]).map(item=>({...item,isEmergency:Boolean(item.isEmergency)}));
  const evidence = await db.prepare("SELECT evidence_policy_json FROM work_type_versions WHERE id IN (SELECT value FROM json_each(?))")
    .bind(JSON.stringify(chosen.map(item=>item.versionId))).all<{evidence_policy_json:string}>();
  const policies=evidence.results.map(row=>parseEvidencePolicy(JSON.parse(row.evidence_policy_json)));
  if (policies.some(policy=>!policy)) throw new WorkCatalogError("В выбранном HD не поддерживаются требования к материалам отчёта. Уточните шаблон работы.");
  if (Math.max(0,...policies.map(policy=>policy!.minPhotos))+Math.max(0,...policies.map(policy=>policy!.minVideos))>8)
    throw new WorkCatalogError("Для этих HD одновременно требуется больше 8 фото и видео. Согласуйте требования к материалам перед созданием составной заявки.");
  const categoryId = payload.categoryId || null;
  const category = categoryId ? await db.prepare("SELECT service_duration_minutes AS duration, duration_source AS source FROM work_categories WHERE id=? AND active=1")
    .bind(categoryId).first<{ duration: number | null; source: string }>() : null;
  if (categoryId) {
    const links = await db.prepare(`SELECT l.work_type_id FROM category_work_types l JOIN work_categories c ON c.id=l.category_id
      WHERE c.id=? AND c.active=1`).bind(categoryId).all<{ work_type_id: string }>();
    if (!ids.every(id => links.results.some(row => row.work_type_id === id))) throw new WorkCatalogError("Все типы HD должны входить в выбранный ВК.");
  } else {
    const links = await db.prepare(`SELECT work_type_id FROM category_work_types WHERE work_type_id IN (${ids.map(() => "?").join(",")})`).bind(...ids).all<{ work_type_id: string }>();
    if (chosen.length > 1 || links.results.length) throw new WorkCatalogError("Выберите тип ВК.");
  }
  const useCategoryNorm = category?.duration != null && (chosen.length === 1 || payload.serviceDurationMinutes === undefined);
  const duration = useCategoryNorm ? category.duration : chosen.length === 1 ? chosen[0].duration : payload.serviceDurationMinutes;
  const durationSource = useCategoryNorm ? category.source : chosen.length === 1 ? "version" : payload.durationSource?.trim();
  if (!isPlannedDurationMinutes(duration) || !durationSource) {
    throw new WorkCatalogError("Для нескольких HD укажите общий норматив обслуживания и его источник; дорога в него не входит.");
  }
  const catalog = await loadWorkTypeCatalogMetadata(db);
  return { categoryId, components: chosen, duration, durationSource,
    equipment: (await listWorkCategories(db)).find(c=>c.id===categoryId)?.equipment ?? mergeEquipmentRequirements(chosen.flatMap(item => catalog.equipment(item.versionId))) };
}

export function orderCompositionStatements(db: D1Database, orderId: string, composition: WorkComposition) {
  return [db.prepare("DELETE FROM work_order_work_types WHERE work_order_id=?").bind(orderId),
    db.prepare("DELETE FROM work_order_equipment WHERE work_order_id=?").bind(orderId),
    ...composition.components.map((item, index) => db.prepare(`INSERT INTO work_order_work_types
      (work_order_id,work_type_version_id,sequence,name_snapshot) VALUES (?,?,?,?)`).bind(orderId, item.versionId, index, item.name)),
    ...composition.equipment.map(item => db.prepare(`INSERT INTO work_order_equipment
      (work_order_id,equipment_id,quantity,name_snapshot,unit_snapshot,usage_snapshot) VALUES (?,?,?,?,?,?)`)
      .bind(orderId, item.equipmentId, item.quantity, item.name, item.unit, item.usage)),
  ];
}

export async function eligibleCompositionWorker(db: D1Database, organizationId: string, name: string, composition: WorkComposition, workerId?: string) {
  if (!name) return null;
  const typeIds = composition.components.map(item => item.workTypeId);
  const placeholders = typeIds.map(() => "?").join(",");
  const rows = await db.prepare(`SELECT w.id FROM workers w WHERE w.organization_id=? AND w.active=1 AND w.full_name=? AND (? IS NULL OR w.id=?)
    AND (? IS NULL OR (SELECT COUNT(DISTINCT c.work_type_id) FROM worker_work_competencies c WHERE c.worker_id=w.id AND c.category_id=? AND c.work_type_id IN (${placeholders}))=?)
    ORDER BY w.id LIMIT 2`)
    .bind(organizationId, name, workerId || null, workerId || null, composition.categoryId, composition.categoryId, ...typeIds, typeIds.length).all<{ id: string }>();
  if (rows.results.length > 1) throw new WorkCatalogError("Есть исполнители с одинаковым именем. Выберите исполнителя по карточке.");
  return rows.results[0]?.id ?? null;
}
