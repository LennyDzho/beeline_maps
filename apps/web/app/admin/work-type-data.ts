import type { EquipmentRequirement, EquipmentSnapshot } from "@/app/lib/work-catalog";

export type VerificationMethodId = "automatic" | "dispatcher" | "route-vision-v1" | "quality-control-v2";

export type WorkTypeRecord = {
  reportTemplate?: import("@/app/lib/report-requirements").ReportTemplate;
  evidencePolicy?: import("@/app/lib/report-requirements").EvidencePolicy;
  isEmergency?: boolean;
  versionId?: string;
  categoryIds?: string[];
  equipmentRequirements?: EquipmentRequirement[];
  equipment?: EquipmentSnapshot[];
  id: string;
  name: string;
  description: string;
  plannedDurationMinutes: number;
  verificationMethodId: VerificationMethodId;
  requiredSkills: string[];
  requiredSkillIds?: string[];
  requiredQualifications: string[];
  requiredQualificationIds?: string[];
};

export const verificationMethods: Array<{ id: VerificationMethodId; label: string; kind: "automatic" | "dispatcher" | "ai" }> = [
  { id: "dispatcher", label: "Диспетчер", kind: "dispatcher" },
  { id: "automatic", label: "Принимать автоматически", kind: "automatic" },
  { id: "route-vision-v1", label: "Route Vision v1", kind: "ai" },
  { id: "quality-control-v2", label: "Quality Control v2", kind: "ai" },
];

export const skillCatalog = ["Электрика", "Клининг", "Сварка", "Монтаж", "Сети", "Диагностика"];
export const qualificationCatalog = ["Допуск 1", "Допуск 2", "Допуск 3", "Мастер", "Работы на высоте", "Электробезопасность"];

export const initialWorkTypes: WorkTypeRecord[] = [
  { id: "WORK-001", name: "Ремонт оборудования", description: "Поиск неисправности, ремонт и контрольный запуск оборудования.", plannedDurationMinutes: 60, verificationMethodId: "dispatcher", requiredSkills: ["Электрика", "Диагностика"], requiredQualifications: ["Допуск 3"] },
  { id: "WORK-002", name: "Плановое ТО", description: "Регламентное техническое обслуживание оборудования и транспорта.", plannedDurationMinutes: 60, verificationMethodId: "route-vision-v1", requiredSkills: ["Диагностика"], requiredQualifications: ["Допуск 2"] },
  { id: "WORK-003", name: "Диагностика сети", description: "Проверка сетевой инфраструктуры и локализация неисправностей.", plannedDurationMinutes: 60, verificationMethodId: "quality-control-v2", requiredSkills: ["Сети", "Диагностика"], requiredQualifications: ["Допуск 2"] },
  { id: "WORK-004", name: "Установка оборудования", description: "Монтаж, подключение и первичная настройка оборудования.", plannedDurationMinutes: 60, verificationMethodId: "dispatcher", requiredSkills: ["Монтаж", "Электрика"], requiredQualifications: ["Допуск 3", "Работы на высоте"] },
];

export function getVerificationMethod(methodId: VerificationMethodId) {
  return verificationMethods.find((method) => method.id === methodId) ?? verificationMethods[0]!;
}
