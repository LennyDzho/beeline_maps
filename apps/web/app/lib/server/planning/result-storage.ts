import type { PlanningResult } from "@/app/dispatcher/planning-types";

/** Lossless storage for long road geometries and before/after comparisons.
 * API consumers always receive the original DTO; legacy plain JSON stays readable. */
export async function serializePlanningResult(result: PlanningResult): Promise<string> {
  const json = JSON.stringify(result);
  if (new TextEncoder().encode(json).byteLength < 128_000) return json;
  const stream = new Response(json).body!.pipeThrough(new CompressionStream("gzip"));
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return JSON.stringify({ storedPlanEncoding: "gzip-base64/v1", data: btoa(binary) });
}

export async function deserializePlanningResult(value: string): Promise<PlanningResult> {
  const parsed = JSON.parse(value);
  if (parsed.storedPlanEncoding !== "gzip-base64/v1") return parsed as PlanningResult;
  const bytes = Uint8Array.from(atob(parsed.data), char => char.charCodeAt(0));
  const stream = new Response(bytes).body!.pipeThrough(new DecompressionStream("gzip"));
  return JSON.parse(await new Response(stream).text()) as PlanningResult;
}
