import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const base = "http://localhost:3000";
const source = await readFile(new URL("../.dev.vars", import.meta.url), "utf8");
const vars = Object.fromEntries(source.split(/\r?\n/).flatMap((line) => {
  const match = /^([A-Z_]+)=(.*)$/.exec(line.trim());
  return match ? [[match[1], match[2].replace(/^["']|["']$/g, "")]] : [];
}));
const cookies = new Map();
async function call(path, method = "GET", body) {
  const response = await fetch(`${base}${path}`, { method, headers: {
    "Content-Type": "application/json", Origin: base,
    Cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join("; "),
  }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(20000) });
  for (const cookie of response.headers.getSetCookie()) {
    const pair = cookie.split(";")[0];
    const index = pair.indexOf("=");
    cookies.set(pair.slice(0, index), pair.slice(index + 1));
  }
  const payload = await response.json();
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}: ${payload.message ?? "request failed"}`);
  return payload;
}

await call("/api/auth/login", "POST", { email: vars.AUTH_BOOTSTRAP_EMAIL, password: vars.AUTH_BOOTSTRAP_PASSWORD });
const context = await call("/api/organization-context");
const original = (await call("/api/admin/bootstrap")).settings;
let otherOriginal;
const other = context.organizations.find((organization) => organization.id !== context.currentOrganizationId);
try {
  if (other) {
    await call("/api/organization-context", "PUT", { organizationId: other.id });
    otherOriginal = (await call("/api/admin/bootstrap")).settings;
    await call("/api/organization-context", "PUT", { organizationId: context.currentOrganizationId });
  }
  for (const [optimizationEngine, travelMatrixProvider] of [["pyvrp", "osrm"], ["two_gis_tsp", "two_gis"], ["pyvrp", "two_gis"]]) {
    await call("/api/admin/settings", "PUT", { ...original, optimizationEngine, travelMatrixProvider });
    const saved = (await call("/api/admin/bootstrap")).settings;
    assert.equal(saved.optimizationEngine, optimizationEngine);
    assert.equal(saved.travelMatrixProvider, travelMatrixProvider);
    console.log(`Saved and reloaded: ${optimizationEngine} / ${travelMatrixProvider}`);
  }
  await assert.rejects(call("/api/admin/settings", "PUT", { ...original, optimizationEngine: "two_gis_tsp", travelMatrixProvider: "osrm" }), /HTTP 400/);
  if (other) {
    await call("/api/organization-context", "PUT", { organizationId: other.id });
    assert.deepEqual((await call("/api/admin/bootstrap")).settings, otherOriginal);
    console.log("Organization isolation: OK");
  }
} finally {
  await call("/api/organization-context", "PUT", { organizationId: context.currentOrganizationId });
  await call("/api/admin/settings", "PUT", original);
  assert.deepEqual((await call("/api/admin/bootstrap")).settings, original);
  console.log("Original settings restored. No plans published.");
}
