import { compareWorkCategories, canonicalWorkName, type WorkCategory, type EquipmentItem, type EquipmentRequirement, type EquipmentSnapshot, type WorkCompetency } from "../work-catalog";

export class WorkCatalogError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

export async function listWorkCategories(db: D1Database): Promise<WorkCategory[]> {
  const rows = await db.prepare("SELECT id, name, description, active, service_duration_minutes AS serviceDurationMinutes, duration_source AS durationSource, equipment_configured FROM work_categories ORDER BY name, id")
    .all<Omit<WorkCategory, "active"> & { active: number; equipment_configured: number }>();
  const equipment = await db.prepare(`SELECT c.category_id,c.equipment_id AS equipmentId,c.quantity,e.name,e.unit,e.usage FROM category_equipment c JOIN equipment_items e ON e.id=c.equipment_id ORDER BY e.name`).all<EquipmentSnapshot & {category_id:string}>();
  return rows.results.map(({equipment_configured,...row}) => ({ ...row, active: Boolean(row.active), ...(equipment_configured ? { equipment: equipment.results.filter(e=>e.category_id===row.id).map(e=>({equipmentId:e.equipmentId,quantity:e.quantity,name:e.name,unit:e.unit,usage:e.usage})) } : {}) })).sort(compareWorkCategories);
}

export async function listEquipmentItems(db: D1Database): Promise<EquipmentItem[]> {
  const rows = await db.prepare("SELECT id, name, unit, usage, active FROM equipment_items ORDER BY name, id")
    .all<Omit<EquipmentItem, "active"> & { active: number }>();
  return rows.results.map(row => ({ ...row, active: Boolean(row.active) }));
}

export async function listWorkerCompetencies(db: D1Database, organizationId: string) {
  const rows = await db.prepare(`SELECT c.worker_id, c.category_id, c.work_type_id FROM worker_work_competencies c
    JOIN workers w ON w.id = c.worker_id WHERE w.organization_id = ? ORDER BY c.worker_id, c.category_id, c.work_type_id`)
    .bind(organizationId).all<{ worker_id: string; category_id: string; work_type_id: string }>();
  const result = new Map<string, WorkCompetency[]>();
  for (const row of rows.results) result.set(row.worker_id, [...result.get(row.worker_id) ?? [], { categoryId: row.category_id, workTypeId: row.work_type_id }]);
  return result;
}

export async function validateCompetencies(db: D1Database, _organizationId: string, items: WorkCompetency[]) {
  const allowed = await db.prepare(`SELECT c.category_id, c.work_type_id FROM category_work_types c
    JOIN work_categories bk ON bk.id = c.category_id JOIN work_types hd ON hd.id = c.work_type_id
    WHERE bk.active = 1 AND hd.active = 1`).all<{ category_id: string; work_type_id: string }>();
  if (!items.every(item => allowed.results.some(row => row.category_id === item.categoryId && row.work_type_id === item.workTypeId))) {
    throw new WorkCatalogError("Проверьте компетенции: каждый HD должен входить в выбранный ВК.");
  }
}

export function workerCompetencyStatements(db: D1Database, workerId: string, items: WorkCompetency[]) {
  return [db.prepare("DELETE FROM worker_work_competencies WHERE worker_id = ?").bind(workerId),
    ...items.map(item => db.prepare("INSERT INTO worker_work_competencies (worker_id, category_id, work_type_id) VALUES (?, ?, ?)").bind(workerId, item.categoryId, item.workTypeId))];
}

export async function loadWorkTypeCatalogMetadata(db: D1Database) {
  const [links, equipment] = await Promise.all([
    db.prepare(`SELECT c.work_type_id, c.category_id FROM category_work_types c JOIN work_types t ON t.id=c.work_type_id
      ORDER BY c.category_id`).all<{ work_type_id: string; category_id: string }>(),
    db.prepare(`SELECT e.* FROM work_type_version_equipment e JOIN work_type_versions v ON v.id=e.work_type_version_id
      JOIN work_types t ON t.id=v.work_type_id ORDER BY e.equipment_id`)
      .all<{ work_type_version_id: string; equipment_id: string; quantity: number | null; name_snapshot: string; unit_snapshot: string; usage_snapshot: EquipmentItem["usage"] }>(),
  ]);
  return {
    categoryIds: (typeId: string) => links.results.filter(row => row.work_type_id === typeId).map(row => row.category_id),
    equipment: (versionId: string): EquipmentSnapshot[] => equipment.results.filter(row => row.work_type_version_id === versionId)
      .map(row => ({ equipmentId: row.equipment_id, quantity: row.quantity, name: row.name_snapshot, unit: row.unit_snapshot, usage: row.usage_snapshot })),
  };
}

export async function workTypeCatalogStatements(db: D1Database, organizationId: string, typeId: string, versionId: string,
  name: string, categoryIds: string[] | undefined, equipment: EquipmentRequirement[] | undefined, previousVersionId?: string) {
  const statements: D1PreparedStatement[] = [];
  const alias = canonicalWorkName(name).toLocaleLowerCase("ru");
  const aliasOwner = await db.prepare("SELECT work_type_id FROM work_type_aliases WHERE alias=?").bind(alias).first<{ work_type_id: string }>();
  const existingNames = await db.prepare("SELECT id, name FROM work_types WHERE id<>?").bind(typeId).all<{ id: string; name: string }>();
  if ((aliasOwner && aliasOwner.work_type_id !== typeId) || existingNames.results.some(row => canonicalWorkName(row.name).toLocaleLowerCase("ru") === alias)) throw new WorkCatalogError("Такой тип HD или его синоним уже существует.", 409);
  if (!aliasOwner) statements.push(db.prepare("INSERT INTO work_type_aliases (organization_id, alias, work_type_id) VALUES (?, ?, ?)").bind(organizationId, alias, typeId));
  if (categoryIds !== undefined) {
    const categories = await listWorkCategories(db);
    if (!categoryIds.every(id => categories.some(category => category.id === id && category.active))) throw new WorkCatalogError("Выберите действующие типы ВК.");
    const used = await db.prepare(`SELECT category_id FROM worker_work_competencies WHERE work_type_id=?
      UNION SELECT o.category_id FROM work_orders o WHERE o.category_id IS NOT NULL AND
        (o.work_type_version_id IN (SELECT id FROM work_type_versions WHERE work_type_id=?) OR EXISTS (
          SELECT 1 FROM work_order_work_types c JOIN work_type_versions v ON v.id=c.work_type_version_id WHERE c.work_order_id=o.id AND v.work_type_id=?))`)
      .bind(typeId, typeId, typeId).all<{ category_id: string }>();
    if (used.results.some(row => !categoryIds.includes(row.category_id))) throw new WorkCatalogError("Нельзя удалить связь ВК → HD: она используется в заявке или компетенциях исполнителя.", 409);
    statements.push(db.prepare("DELETE FROM category_work_types WHERE work_type_id=?").bind(typeId),
      ...categoryIds.map(id => db.prepare("INSERT INTO category_work_types (category_id, work_type_id) VALUES (?, ?)").bind(id, typeId)));
  }
  if (equipment === undefined && previousVersionId) {
    statements.push(db.prepare(`INSERT INTO work_type_version_equipment SELECT ?, equipment_id, quantity, name_snapshot, unit_snapshot, usage_snapshot
      FROM work_type_version_equipment WHERE work_type_version_id=?`).bind(versionId, previousVersionId));
  } else {
    const catalog = await listEquipmentItems(db);
    for (const requirement of equipment ?? []) {
      const item = catalog.find(item => item.id === requirement.equipmentId && item.active);
      if (!item) throw new WorkCatalogError("Выберите действующее оборудование.");
      statements.push(db.prepare(`INSERT INTO work_type_version_equipment
        (work_type_version_id,equipment_id,quantity,name_snapshot,unit_snapshot,usage_snapshot) VALUES (?,?,?,?,?,?)`)
        .bind(versionId, item.id, requirement.quantity, item.name, item.unit, item.usage));
    }
  }
  return statements;
}
