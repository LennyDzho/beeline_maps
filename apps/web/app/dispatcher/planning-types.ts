export type PlanningVisitResult = {
  jobId: string;
  label: string;
  address: string;
  arrivalAt: string;
  serviceStartAt: string;
  serviceEndAt: string;
  travelMinutes: number;
  distanceKm: number;
  point: { lat: number; lon: number };
  change?: {
    kind: "assigned" | "reassigned" | "rescheduled";
    label: string;
    previousAgentName?: string;
    previousStartAt?: string;
  };
};

export type PlanningRouteResult = {
  agentId: string;
  agentName: string;
  initials: string;
  vehicle: string;
  transportMode: "driving" | "public_transport" | "walking" | "truck" | "cycling" | "scooter";
  scheduleName: string;
  timezone: string;
  shiftStartAt: string;
  shiftEndAt: string;
  breaks: Array<{ startAt: string; endAt: string }>;
  startPoint: { lat: number; lon: number };
  endPoint: { lat: number; lon: number };
  geometry: Array<{ lat: number; lon: number }>;
  geometrySource: "2gis" | "osrm" | "fallback";
  loadPercent: number;
  availableMinutes: number;
  totalTravelMinutes: number;
  totalDistanceKm: number;
  returnAt: string | null;
  returnTravelMinutes: number;
  visits: PlanningVisitResult[];
};

export type PlanningUnassignedResult = {
  jobId: string;
  label: string;
  address: string;
  reason: string;
  detail: string;
};

export type PlanningResult = {
  departments?: Array<{ id: string; name: string; timezone: string; planId: string | null; jobIds: string[]; workerIds: string[]; planningAt?: string; providerId?: string; optimizerId?: string; metrics: PlanningResult["metrics"] }>;
  planningAt?: string;
  protectedJobIds?: string[];
  planId: string;
  status: "draft" | "published";
  serviceDate: string;
  providerId: string;
  optimizerId: string;
  metrics: {
    totalJobs: number;
    plannedJobs: number;
    unassignedJobs: number;
    engineersUsed: number;
    totalEngineers: number;
    totalTravelMinutes: number;
    totalDistanceKm: number;
    hardViolations: number;
    score: number;
  };
  routes: PlanningRouteResult[];
  previousRoutes?: PreviousPlanningRoute[];
  changes?: PlanningAssignmentChange[];
  clientApprovals?: Array<PlanningAssignmentChange & { id: string }>;
  unassigned: PlanningUnassignedResult[];
  warnings: string[];
};

/** Actual unstarted assignments at calculation time, not a historical GPS track. */
export type PreviousPlanningRoute = {
  agentId: string;
  agentName: string;
  startPoint: { lat: number; lon: number } | null;
  visits: Array<{ jobId: string; label: string; startAt: string; timezone: string; point: { lat: number; lon: number } | null }>;
  geometry: Array<{ lat: number; lon: number }>;
  geometrySource: "2gis" | "osrm" | "fallback";
  warning?: string;
};

export type PlanningAssignmentChange = {
  jobId: string; label: string; reason: string;
  before: import("@/app/lib/scheduling-changes").ScheduleSnapshot & { sequence: number | null };
  after: import("@/app/lib/scheduling-changes").ScheduleSnapshot & { sequence: number | null };
};
