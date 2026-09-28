export type QualificationRecord = {
  id: string;
  code: string;
  name: string;
  description: string;
  active: boolean;
  workerCount: number;
  workTypeCount: number;
};

export type QualificationInput = Pick<QualificationRecord, "name" | "description" | "active">;

export function isQualificationIds(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.length <= 200
    && value.every((id) => typeof id === "string" && id.trim().length > 0 && id.length <= 200)
    && new Set(value).size === value.length;
}
