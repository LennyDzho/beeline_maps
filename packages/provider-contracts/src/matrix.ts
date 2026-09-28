import type {
  DateTime,
  IdentifiedPoint,
  ProviderRequestOptions,
  ProviderResult,
} from "./common.js";
import type { TravelProfile } from "./mobility.js";

export interface TravelTimeMatrixRequest {
  readonly origins: ReadonlyArray<IdentifiedPoint>;
  readonly destinations: ReadonlyArray<IdentifiedPoint>;
  readonly profile: TravelProfile;
  readonly departureAt?: DateTime;
}

export type MatrixCell =
  | {
      readonly status: "ok";
      readonly originId: string;
      readonly destinationId: string;
      readonly durationSeconds: number;
      readonly distanceMeters: number;
    }
  | {
      readonly status: "no_route" | "unavailable";
      readonly originId: string;
      readonly destinationId: string;
      readonly reason?: string;
    };

export interface TravelTimeMatrix {
  readonly originIds: ReadonlyArray<string>;
  readonly destinationIds: ReadonlyArray<string>;
  /** Row-major cells: every origin in order, then every destination in order. */
  readonly cells: ReadonlyArray<MatrixCell>;
}

export interface TravelTimeMatrixPort {
  readonly providerId: string;

  calculate(
    request: TravelTimeMatrixRequest,
    options?: ProviderRequestOptions,
  ): Promise<ProviderResult<TravelTimeMatrix>>;
}

export function getMatrixCell(
  matrix: TravelTimeMatrix,
  originId: string,
  destinationId: string,
): MatrixCell | undefined {
  return matrix.cells.find(
    (cell) => cell.originId === originId && cell.destinationId === destinationId,
  );
}

