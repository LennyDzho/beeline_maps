export type VehicleStatus = "working" | "repair" | "available";

export type Vehicle = {
  id: string;
  name: string;
  type: "Фургон" | "Легковой";
  plate: string;
  region: string;
  status: VehicleStatus;
  assignment?: string;
  plannedJobs?: number;
  nextPlannedAt?: string;
  condition: "Исправен" | "service";
  serviceDate?: string;
  vin?: string;
  section?: string;
  notes?: string;
};

export const vehicles: Vehicle[] = [
  { id: "B732YO", name: "Ford Transit", type: "Фургон", plate: "B732YO", region: "77", status: "working", assignment: "Алексей Иванов", condition: "Исправен", section: "Север" },
  { id: "K901MM", name: "Lada Largus", type: "Легковой", plate: "K901MM", region: "77", status: "repair", condition: "service", serviceDate: "2023-10-25", section: "Центр" },
  { id: "E445AA", name: "Renault Kangoo", type: "Фургон", plate: "E445AA", region: "777", status: "available", condition: "Исправен", section: "Юг" },
];

export const statusLabels: Record<VehicleStatus, string> = {
  working: "В работе",
  repair: "В ремонте",
  available: "Свободен",
};

export const statusIcons: Record<VehicleStatus, string> = {
  working: "route",
  repair: "build",
  available: "check_circle",
};
