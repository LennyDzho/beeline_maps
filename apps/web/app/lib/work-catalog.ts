export type WorkCategory = { id: string; name: string; description: string; active: boolean; serviceDurationMinutes?: number | null; durationSource?: string; equipment?: EquipmentSnapshot[] };
export type EquipmentUsage = "unspecified" | "consumable" | "reusable";
export type EquipmentItem = { id: string; name: string; unit: string; usage: EquipmentUsage; active: boolean };
export type EquipmentRequirement = { equipmentId: string; quantity: number | null };
export type EquipmentSnapshot = EquipmentRequirement & { name: string; unit: string; usage: EquipmentUsage };
export type WorkCompetency = { categoryId: string; workTypeId: string };

export function canonicalWorkName(value: string): string {
  const name = value.trim().replace(/\s+/gu, " ");
  return /^(заказ|заявка)( на)? подключени[ея]$/iu.test(name) ? "Заявка на подключение" : name;
}

export function splitSourceWorkNames(value: string): string[] {
  // A slash also occurs inside indivisible names: TVE/ENT and Гбит/с.
  const names = /^(заказ|заявка)( на)? подключения\s*\/\s*дозаказ оборудования$/iu.test(value.trim()) ? value.split("/") : [value];
  return [...new Set(names.map(canonicalWorkName).filter(Boolean))];
}

export function isUniqueIds(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= 100 && value.every(id => typeof id === "string" && id.length > 0 && id.length <= 150)
    && new Set(value).size === value.length;
}

export function isEquipmentRequirements(value: unknown): value is EquipmentRequirement[] {
  return Array.isArray(value) && value.length <= 100 && value.every(item => item && typeof item === "object"
    && typeof item.equipmentId === "string" && item.equipmentId.length > 0 && item.equipmentId.length <= 150
    && (item.quantity === null || (typeof item.quantity === "number" && Number.isFinite(item.quantity) && item.quantity > 0 && item.quantity <= 1_000_000)))
    && new Set(value.map(item => item.equipmentId)).size === value.length;
}

export function isWorkCompetencies(value: unknown): value is WorkCompetency[] {
  return Array.isArray(value) && value.length <= 500 && value.every(item => item && typeof item === "object"
    && typeof item.categoryId === "string" && item.categoryId.length > 0 && item.categoryId.length <= 150
    && typeof item.workTypeId === "string" && item.workTypeId.length > 0 && item.workTypeId.length <= 150)
    && new Set(value.map(item => `${item.categoryId}\u0000${item.workTypeId}`)).size === value.length;
}

export function hasWorkCompetencies(competencies: readonly WorkCompetency[], categoryId: string, workTypeIds: readonly string[]) {
  return workTypeIds.every(workTypeId => competencies.some(item => item.categoryId === categoryId && item.workTypeId === workTypeId));
}

export function mergeEquipmentRequirements(items: readonly EquipmentSnapshot[]): EquipmentSnapshot[] {
  const grouped = new Map<string, EquipmentSnapshot>();
  for (const item of items) {
    const previous = grouped.get(item.equipmentId);
    if (!previous) { grouped.set(item.equipmentId, { ...item }); continue; }
    // A reusable tool serves consecutive HD operations in the same visit.
    // Unknown usage or quantity must never turn into a fabricated numeric total.
    const compatible = previous.unit === item.unit && previous.usage === item.usage;
    previous.quantity = !compatible || previous.quantity === null || item.quantity === null || item.usage === "unspecified"
      ? null : item.usage === "reusable" ? Math.max(previous.quantity, item.quantity) : previous.quantity + item.quantity;
    if (!compatible) { previous.usage = "unspecified"; previous.unit = ""; }
  }
  return [...grouped.values()];
}

const categoryOrder = ['Подключение', 'Дозаказ', 'Локальная заявка', 'Глобальная проблема'];
export function compareWorkCategories(a: WorkCategory, b: WorkCategory) {
  const rank = (name: string) => { const index=categoryOrder.indexOf(name); return index<0 ? categoryOrder.length : index; };
  return rank(a.name)-rank(b.name) || a.name.localeCompare(b.name, 'ru');
}
