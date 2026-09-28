export const OPTIMIZATION_ENGINE_OPTIONS = [
  { id: "pyvrp", label: "PyVRP", description: "Поиск маршрутов PyVRP с обработкой аварий и перепланированием. Учитывает окна заявок, перерывы, компетенции и оборудование." },
  { id: "ortools", label: "OR-Tools Routing", description: "Максимум выполненных заявок, приоритет аварий и минимум исполнителей." },
  {
    id: "two_gis_tsp",
    label: "2ГИС TSP/VRP",
    description: "Распределение через TSP API 2ГИС. Требует доступа к TSP API; использует дорожные данные 2ГИС. Общественный транспорт не поддерживается.",
  },
] as const;

export const OSRM_TRAVEL_WARNING = "OSRM рассчитывает время и расстояния для всех бригад по автомобильным дорогам, без пробок. Для бригад без автомобиля это приближённая оценка: общественный транспорт, расписания и пересадки не учитываются.";

export const TRAVEL_MATRIX_PROVIDER_OPTIONS = [
  {
    id: "two_gis",
    label: "2ГИС",
    description: "Дорожная матрица и линии маршрутов 2ГИС с учётом выбранного вида транспорта.",
  },
  {
    id: "osrm",
    label: "OSRM · OpenStreetMap",
    description: "Расстояния и время по дорогам OpenStreetMap. Все виды исполнителей участвуют в расчёте. По умолчанию — публичные тестовые серверы; для постоянной работы нужен свой сервер OSRM.",
  },
] as const;

export type OptimizationEngineId = typeof OPTIMIZATION_ENGINE_OPTIONS[number]["id"];
export type TravelMatrixProviderId = typeof TRAVEL_MATRIX_PROVIDER_OPTIONS[number]["id"];

export type PlanningSettings = {
  calculationTimeoutSeconds?: number;
  optimizationEngine: OptimizationEngineId;
  travelMatrixProvider: TravelMatrixProviderId;
  optimizerPolicy?: OptimizerPolicy;
};

export const OPTIMIZER_POLICY_OPTIONS = [
  { id: "emergency_fast/v1", label: "Аварии — как можно раньше", description: "Максимум заявок → максимум аварий → раннее начало аварий → минимум исполнителей → пробег." },
  { id: "emergency_staff/v1", label: "Аварии — с минимальным штатом", description: "Максимум заявок → максимум аварий → минимум исполнителей → раннее начало аварий → пробег." },
] as const;
export type OptimizerPolicy = typeof OPTIMIZER_POLICY_OPTIONS[number]["id"];
export const DEFAULT_OPTIMIZER_POLICY: OptimizerPolicy = "emergency_fast/v1";
export const isOptimizerPolicy = (value: unknown): value is OptimizerPolicy => OPTIMIZER_POLICY_OPTIONS.some(p => p.id === value);

export const DEFAULT_PLANNING_SETTINGS: PlanningSettings = {
  calculationTimeoutSeconds: 180,
  optimizationEngine: "pyvrp",
  travelMatrixProvider: "two_gis",
};

export const DEFAULT_CALCULATION_TIMEOUT_SECONDS = 180;
export const isCalculationTimeoutSeconds = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 30 && value <= 1800;

export function isOptimizationEngineId(value: unknown): value is OptimizationEngineId {
  return OPTIMIZATION_ENGINE_OPTIONS.some((option) => option.id === value);
}

export function isTravelMatrixProviderId(value: unknown): value is TravelMatrixProviderId {
  return TRAVEL_MATRIX_PROVIDER_OPTIONS.some((option) => option.id === value);
}

export function isPlanningCombinationSupported(engine: OptimizationEngineId, matrix: TravelMatrixProviderId): boolean {
  return engine !== "two_gis_tsp" || matrix === "two_gis";
}

export function travelSourceLabel(providerId: string): string {
  if (providerId.includes(" + ")) return providerId.split(" + ").map(travelSourceLabel).join("; ");
  return providerId === "osrm" ? "по дорогам OSRM / OSM" : providerId === "2gis" ? "по дорогам 2ГИС" : "локальная оценка";
}
