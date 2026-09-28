import type { EquipmentSnapshot } from "./work-catalog";

export type BrigadeEquipment = { departedAt: string; items: EquipmentSnapshot[] | null; source: string };

/** Missing state means the brigade can still collect the day's kit at the office. */
export function equipmentWarning(required: readonly EquipmentSnapshot[], state: BrigadeEquipment | undefined): string | null {
  if (!state || !required.length) return null;
  if (state.items === null) return `Бригада уже выехала; полученное оборудование не указано. Проверьте: ${required.map(item => item.name).join(", ")}.`;
  const missing = required.filter(item => !state.items!.some(owned => owned.equipmentId === item.equipmentId));
  return missing.length ? `У бригады нет оборудования: ${missing.map(item => item.name).join(", ")}.` : null;
}
