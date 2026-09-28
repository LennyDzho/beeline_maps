import type {
  DateTime,
  GeoPoint,
  ProviderRequestOptions,
  TimeWindow,
} from "./common.js";
import type { TravelProfile } from "./mobility.js";

export type JobState =
  | "new"
  | "planned"
  | "client_confirmed"
  | "in_progress"
  | "completed"
  | "cancelled";

export type ChangePolicy =
  | "free"
  | "dispatcher_approval_required"
  | "immutable";

export interface BaselineVisit {
  readonly agentId: string;
  readonly arrivalAt: DateTime;
  readonly serviceStartAt: DateTime;
  readonly serviceEndAt: DateTime;
  readonly sequence: number;
}

export interface SoftTimeWindow extends TimeWindow {
  readonly penaltyPerMinute: number;
}

export interface ResourceRequirement {
  readonly kind: "vehicle" | "equipment";
  readonly allTags?: ReadonlyArray<string>;
  readonly anyTags?: ReadonlyArray<string>;
  readonly quantity?: number;
}

export interface PlanningJob {
  readonly id: string;
  readonly location: GeoPoint;
  readonly serviceDurationSeconds: number;
  readonly state: JobState;
  readonly changePolicy: ChangePolicy;
  readonly hardTimeWindows: ReadonlyArray<TimeWindow>;
  readonly softTimeWindows?: ReadonlyArray<SoftTimeWindow>;
  readonly requiredSkills?: ReadonlyArray<string>;
  readonly requiredEquipmentIds?: ReadonlyArray<string>;
  readonly requiredResources?: ReadonlyArray<ResourceRequirement>;
  readonly priority?: number;
  readonly isEmergency?: boolean;
  /** Earliest start after the request or replanning event became known. */
  readonly releaseAt?: DateTime;
  readonly dropPenalty?: number;
  readonly baseline?: BaselineVisit;
}

export interface AgentShift {
  readonly id: string;
  readonly window: TimeWindow;
  readonly breaks?: ReadonlyArray<TimeWindow>;
  readonly startLocation: GeoPoint;
  readonly endLocation?: GeoPoint;
}

export interface PlanningAgent {
  readonly id: string;
  /** Already used by protected work; additional route does not engage another person. */
  readonly alreadyEngaged?: boolean;
  /** Absent: at the office, can collect the planned kit. Empty: departed without known equipment. */
  readonly availableEquipmentIds?: ReadonlyArray<string>;
  readonly skills: ReadonlyArray<string>;
  /** Overrides the problem-wide profile for heterogeneous fleets. */
  readonly travelProfile?: TravelProfile;
  /** Tags of resources fixed to this agent for the planning horizon. */
  readonly fixedResourceTags: ReadonlyArray<string>;
  readonly shifts: ReadonlyArray<AgentShift>;
  readonly maxJobs?: number;
  readonly maxTravelSeconds?: number;
  readonly maxDistanceMeters?: number;
  readonly travelTimeMultiplier?: number;
}

export interface PlanningResource {
  readonly id: string;
  readonly kind: "vehicle" | "equipment";
  readonly tags: ReadonlyArray<string>;
  readonly availability: ReadonlyArray<TimeWindow>;
  readonly assignment:
    | { readonly kind: "fixed_to_agent"; readonly agentId: string }
    | { readonly kind: "shared_pool"; readonly depotLocation?: GeoPoint };
}

export type PlanningObjectiveKind =
  | "maximize_completed"
  | "maximize_emergencies_completed"
  | "minimize_emergency_delay"
  | "minimize_agents_used"
  | "minimize_distance"
  | "minimize_sla_violation"
  | "maximize_priority_completed"
  | "minimize_confirmed_changes"
  | "minimize_travel_time"
  | "balance_agent_load";

export interface PlanningObjective {
  readonly kind: PlanningObjectiveKind;
  readonly weight: number;
}

export interface PlanningProblem {
  readonly id: string;
  readonly horizon: TimeWindow;
  readonly profile: TravelProfile;
  readonly jobs: ReadonlyArray<PlanningJob>;
  readonly agents: ReadonlyArray<PlanningAgent>;
  readonly resources: ReadonlyArray<PlanningResource>;
  /** Ordered by business priority; weight breaks ties inside one priority level. */
  readonly objectives: ReadonlyArray<PlanningObjective>;
}

export interface PlannedVisit {
  readonly jobId: string;
  readonly arrivalAt: DateTime;
  readonly serviceStartAt: DateTime;
  readonly serviceEndAt: DateTime;
  readonly travelSecondsFromPrevious: number;
  readonly distanceMetersFromPrevious: number;
  /** Exact application resource ids reserved for this visit. */
  readonly resourceIds?: ReadonlyArray<string>;
}

/** Final leg from the last visit to the shift end location. */
export interface PlannedRouteEndLeg {
  readonly departureAt: DateTime;
  readonly arrivalAt: DateTime;
  readonly travelSeconds: number;
  readonly distanceMeters: number;
}

export interface PlannedAgentRoute {
  readonly agentId: string;
  readonly shiftId: string;
  readonly visits: ReadonlyArray<PlannedVisit>;
  /** Required by the validator when the shift declares an end location. */
  readonly endLeg?: PlannedRouteEndLeg;
  readonly totalTravelSeconds: number;
  readonly totalDistanceMeters: number;
}

export interface PlanChange {
  readonly jobId: string;
  readonly kind: "assigned" | "unassigned" | "agent_changed" | "time_changed" | "order_changed";
  readonly before?: BaselineVisit;
  readonly after?: BaselineVisit;
}

export interface ApprovalRequirement {
  readonly id: string;
  readonly kind: "dispatcher_confirmed_client_notified";
  readonly jobId: string;
  readonly blocking: true;
  readonly reason: string;
}

export interface UnassignedJob {
  readonly jobId: string;
  readonly reason:
    | "no_qualified_agent"
    | "resource_unavailable"
    | "time_window_infeasible"
    | "no_route"
    | "capacity_exceeded"
    | "excluded_by_objective"
    | "unknown";
  readonly detail?: string;
}

export interface OptimizationDiagnostics {
  readonly durationMs: number;
  readonly engineId: string;
  readonly warnings: ReadonlyArray<string>;
  readonly objectiveValues?: Readonly<Record<string, number>>;
}

export interface PlanProposal {
  readonly id: string;
  readonly problemId: string;
  readonly status: "ready" | "requires_approval" | "infeasible";
  readonly routes: ReadonlyArray<PlannedAgentRoute>;
  readonly unassigned: ReadonlyArray<UnassignedJob>;
  readonly changes: ReadonlyArray<PlanChange>;
  readonly approvals: ReadonlyArray<ApprovalRequirement>;
  readonly diagnostics: OptimizationDiagnostics;
}

export interface OptimizationEnginePort {
  readonly engineId: string;

  optimize(
    problem: PlanningProblem,
    options?: ProviderRequestOptions,
  ): Promise<PlanProposal>;
}
