import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ProviderError,
  type ProviderResult,
  type TravelTimeMatrix,
  type TravelTimeMatrixPort,
  type TravelTimeMatrixRequest,
} from "@mmi/provider-contracts";
import { ResilientMatrixAdapter } from "../app/lib/server/planning/resilient-matrix.js";
import { fetchTwoGis } from "../app/lib/server/planning/two-gis-fetch.js";
import { TwoGisMatrixAdapter } from "../app/lib/server/planning/two-gis-matrix.js";

const grid = Array.from({ length: 23 }, (_, index) => ({ id: `point-${index}`, point: { lat: 55.75, lon: 37 + index / 1_000 } }));
type MatrixBody = { points: { lat: number; lon: number }[]; sources: number[]; targets: number[]; transport: string; start_time?: string };
const indexOf = (point: { lon: number }) => Math.round((point.lon - 37) * 1_000);
const duration = (source: number, target: number) => source === target ? 0 : (source + 1) * 100 + target;
function matrixResponse(body: MatrixBody): Response {
  assert.ok(body.sources.length <= 10);
  assert.ok(body.targets.length <= 10);
  return Response.json({ routes: body.sources.flatMap((source) => body.targets.map((target) => ({
    source_id: source, target_id: target, status: "OK",
    duration: duration(indexOf(body.points[source]!), indexOf(body.points[target]!)),
    distance: duration(indexOf(body.points[source]!), indexOf(body.points[target]!)) * 3,
  }))) });
}

describe("2GIS matrix subscription limits", () => {
  it("splits 11 × 11 into four blocks and restores all directed pairs in row-major order", async () => {
    const bodies: MatrixBody[] = [];
    const adapter = new TwoGisMatrixAdapter("test-key", async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as MatrixBody;
      bodies.push(body);
      return matrixResponse(body);
    });
    const points = grid.slice(0, 11);
    const result = await adapter.calculate({ origins: points, destinations: points, profile: { mode: "walking" }, departureAt: "2026-09-09T08:00:00Z" });
    assert.deepEqual(bodies.map((body) => [body.sources.length, body.targets.length]), [[10, 10], [10, 1], [1, 10], [1, 1]]);
    assert.ok(bodies.every((body) => body.transport === "walking" && body.start_time === "2026-09-09T08:00:00Z"));
    assert.deepEqual(result.data.originIds, points.map((point) => point.id));
    assert.deepEqual(result.data.destinationIds, points.map((point) => point.id));
    assert.deepEqual(result.data.cells, points.flatMap((origin, row) => points.map((destination, column) => ({
      originId: origin.id, destinationId: destination.id, status: "ok",
      durationSeconds: duration(row, column), distanceMeters: duration(row, column) * 3,
    }))));
  });

  it("preserves every pair in a rectangular matrix with disjoint source and target blocks", async () => {
    let calls = 0;
    const adapter = new TwoGisMatrixAdapter("test-key", async (_url, init) => {
      calls++;
      return matrixResponse(JSON.parse(String(init?.body)) as MatrixBody);
    });
    const origins = grid.slice(0, 11);
    const destinations = grid.slice(11);
    const result = await adapter.calculate({ origins, destinations, profile: { mode: "driving" } });
    assert.equal(calls, 4);
    assert.deepEqual(result.data.cells, origins.flatMap((origin, row) => destinations.map((destination, column) => ({
      originId: origin.id, destinationId: destination.id, status: "ok",
      durationSeconds: duration(row, column + 11), distanceMeters: duration(row, column + 11) * 3,
    }))));
  });

  it("keeps unavailable cross-block routes instead of replacing them with straight-line estimates", async () => {
    const adapter = new TwoGisMatrixAdapter("test-key", async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as MatrixBody;
      const payload = await matrixResponse(body).json();
      for (const route of payload.routes) {
        if (indexOf(body.points[route.source_id]!) === 0 && indexOf(body.points[route.target_id]!) === 10) route.status = "ROUTE_NOT_FOUND";
      }
      return Response.json(payload);
    });
    const result = await adapter.calculate({ origins: grid.slice(0, 11), destinations: grid.slice(0, 11), profile: { mode: "driving" } });
    assert.deepEqual(result.data.cells[10], { originId: "point-0", destinationId: "point-10", status: "no_route", reason: "ROUTE_NOT_FOUND" });
    assert.equal(result.data.cells[110]?.status, "ok");
  });

  it("distinguishes dimension rejection from authentication without leaking the provider body", async () => {
    let calls = 0;
    const secret = "test-secret-must-not-leak";
    const adapter = new TwoGisMatrixAdapter(secret, async () => {
      calls++;
      return Response.json({ type: "forbidden", error_message: `permissible dimension of the matrix is exceeded (src x trg): 10x10; url=https://example/?key=${secret}` }, { status: 403 });
    });
    await assert.rejects(adapter.calculate({ origins: [grid[0]!], destinations: [grid[1]!], profile: { mode: "driving" } }), (error: unknown) => {
      assert.ok(error instanceof ProviderError);
      assert.equal(error.code, "INVALID_REQUEST");
      assert.equal(error.httpStatus, 403);
      assert.equal(error.retryable, false);
      assert.match(error.message, /10 × 10/);
      assert.doesNotMatch(error.message, /отклонил ключ|test-secret|https:/);
      return true;
    });
    assert.equal(calls, 1);
  });

  it("still reports actual key rejection, including non-JSON error responses", async () => {
    for (const status of [401, 403]) {
      let calls = 0;
      const adapter = new TwoGisMatrixAdapter("test-key", async () => { calls++; return new Response("Access denied", { status }); });
      await assert.rejects(adapter.calculate({ origins: [grid[0]!], destinations: [grid[1]!], profile: { mode: "driving" } }), (error: unknown) =>
        error instanceof ProviderError && error.code === (status === 401 ? "AUTHENTICATION" : "FORBIDDEN") && error.httpStatus === status);
      assert.equal(calls, 1);
    }
  });

  it("stops before the next block if cancelled and does not return a partial matrix", async () => {
    const controller = new AbortController();
    let calls = 0;
    const adapter = new TwoGisMatrixAdapter("test-key", async (_url, init) => {
      calls++;
      controller.abort();
      return matrixResponse(JSON.parse(String(init?.body)) as MatrixBody);
    });
    await assert.rejects(adapter.calculate({ origins: grid.slice(0, 11), destinations: grid.slice(0, 11), profile: { mode: "driving" } }, { signal: controller.signal }),
      (error: unknown) => error instanceof ProviderError && error.code === "CANCELLED");
    assert.equal(calls, 1);
  });

  it("validates conflicting IDs across blocks before calling 2GIS", async () => {
    let calls = 0;
    const adapter = new TwoGisMatrixAdapter("test-key", async () => { calls++; return Response.json({}); });
    await assert.rejects(adapter.calculate({ origins: grid.slice(0, 11), destinations: [{ id: "point-10", point: grid[0]!.point }], profile: { mode: "driving" } }),
      (error: unknown) => error instanceof ProviderError && error.code === "INVALID_REQUEST");
    assert.equal(calls, 0);
  });
});

describe("2GIS request resilience", () => {
  it("retries a transient service response", async () => {
    let calls = 0;
    const fetcher = (async () => {
      calls += 1;
      return new Response(null, { status: calls === 1 ? 503 : 200 });
    }) as typeof fetch;

    const response = await fetchTwoGis(
      new URL("https://routing.api.2gis.com/get_dist_matrix"),
      { method: "POST" },
      { timeoutMs: 1_000, attempts: 2, retryDelayMs: 0 },
      fetcher,
    );

    assert.equal(response.status, 200);
    assert.equal(calls, 2);
  });

  it("does not retry a client request error", async () => {
    let calls = 0;
    const fetcher = (async () => {
      calls += 1;
      return new Response(null, { status: 400 });
    }) as typeof fetch;

    const response = await fetchTwoGis(
      new URL("https://routing.api.2gis.com/get_dist_matrix"),
      { method: "POST" },
      { timeoutMs: 1_000, attempts: 2, retryDelayMs: 0 },
      fetcher,
    );

    assert.equal(response.status, 400);
    assert.equal(calls, 1);
  });
});

describe("matrix fallback diagnostics", () => {
  it("reports the provider that actually supplied the matrix", async () => {
    const primary = new FailingMatrix();
    const fallback = new SuccessfulMatrix();
    const adapter = new ResilientMatrixAdapter(primary, fallback);

    await adapter.calculate({
      origins: [{ id: "a", point: { lat: 55.75, lon: 37.61 } }],
      destinations: [{ id: "b", point: { lat: 55.76, lon: 37.62 } }],
      profile: { mode: "driving" },
    });

    assert.equal(adapter.providerId, "local-estimated");
    assert.equal(adapter.warnings.length, 1);
  });
});

class FailingMatrix implements TravelTimeMatrixPort {
  readonly providerId = "2gis";

  async calculate(): Promise<ProviderResult<TravelTimeMatrix>> {
    throw new ProviderError({ code: "TIMEOUT", providerId: this.providerId, message: "timeout", retryable: true });
  }
}

class SuccessfulMatrix implements TravelTimeMatrixPort {
  readonly providerId = "local-estimated";

  async calculate(request: TravelTimeMatrixRequest): Promise<ProviderResult<TravelTimeMatrix>> {
    return {
      data: {
        originIds: request.origins.map((point) => point.id),
        destinationIds: request.destinations.map((point) => point.id),
        cells: request.origins.flatMap((origin) => request.destinations.map((destination) => ({
          status: "ok" as const,
          originId: origin.id,
          destinationId: destination.id,
          durationSeconds: 60,
          distanceMeters: 500,
        }))),
      },
      meta: { providerId: this.providerId, receivedAt: new Date(0).toISOString(), cache: "bypass" },
    };
  }
}
