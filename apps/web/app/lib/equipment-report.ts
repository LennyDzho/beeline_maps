import type { EquipmentSnapshot } from "./work-catalog";

export type EquipmentReport = {
  serviceDate: string; planId: string | null; requestCount: number; missingEquipmentOrderIds: string[]; missingEquipmentOrderNumbers?: string[];
  groups: { organizationId?: string; departmentName?: string; workerId: string | null; workerName: string; issued?: import("./brigade-equipment").BrigadeEquipment; items: {
    equipmentId: string; name: string; unit: string; quantity: number | null; usage: EquipmentSnapshot["usage"];
    requests: { id: string; number?: string; quantity: number | null }[];
  }[] }[];
};

export function buildEquipmentReport(orders: { id: string; number?: string; workerId: string | null; workerName: string; equipment: EquipmentSnapshot[] }[], serviceDate: string, planId: string | null): EquipmentReport {
  const groups = new Map<string | null, EquipmentReport["groups"][number]>();
  for (const order of orders) {
    const group = groups.get(order.workerId) ?? { workerId: order.workerId, workerName: order.workerName, items: [] };
    groups.set(order.workerId, group);
    for (const source of order.equipment) {
      const previous = group.items.find(item => item.equipmentId === source.equipmentId);
      if (!previous) group.items.push({ ...source, requests: [{ id: order.id, ...(order.number ? {number:order.number} : {}), quantity: source.quantity }] });
      else {
        const compatible = previous.unit === source.unit && previous.usage === source.usage;
        // A report must not presume that equipment can be reused between visits.
        // Reusable/unspecified items retain per-request quantities without a fake total.
        previous.quantity = compatible && source.usage === "consumable" && source.quantity !== null && previous.quantity !== null ? previous.quantity + source.quantity : null;
        if (!compatible) { previous.unit = ""; previous.usage = "unspecified"; }
        previous.requests.push({ id: order.id, ...(order.number ? {number:order.number} : {}), quantity: source.quantity });
      }
    }
  }
  return { serviceDate, planId, missingEquipmentOrderNumbers: orders.filter(item=>!item.equipment.length).map(item=>item.number ?? "Без номера"), requestCount: orders.length, missingEquipmentOrderIds: orders.filter(item => !item.equipment.length).map(item => item.id),
    groups: [...groups.values()].sort((a, b) => a.workerId === null ? 1 : b.workerId === null ? -1 : a.workerName.localeCompare(b.workerName, "ru")) };
}
