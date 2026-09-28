import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./cloudflare-loader.mjs", import.meta.url));

async function getWorker() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker;
}

async function render(worker, pathname) {
  return worker.fetch(
    new Request(`http://localhost${pathname}`, { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("unauthenticated visitors are sent to the email and password login", async () => {
  const worker = await getWorker();
  const protectedResponse = await render(worker, "/");
  assert.equal(protectedResponse.status, 307);
  assert.equal(protectedResponse.headers.get("location"), "/login");

  const response = await render(worker, "/login");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>Марш! — диспетчерская<\/title>/i);
  assert.match(html, /Вход в систему/);
  assert.match(html, /dispatcher@company\.ru/);
  assert.match(html, /type="email"/);
  assert.match(html, /type="password"/);
  assert.doesNotMatch(html, /Войти через OpenAI|Sign in with ChatGPT/i);
  assert.doesNotMatch(html, /codex-preview|SkeletonPreview|Your site is taking shape/);
});

test("mobile field-service screens remain protected by the same account session", async () => {
  const worker = await getWorker();

  for (const pathname of ["/mobile/today", "/mobile/visits/A-1428"]) {
    const response = await render(worker, pathname);
    assert.equal(response.status, 307);
    assert.equal(response.headers.get("location"), "/login");
  }
});

test("all desktop workspaces are protected by the application account session", async () => {
  const worker = await getWorker();

  for (const pathname of ["/requests", "/engineers", "/resources", "/reports", "/admin"]) {
    const response = await render(worker, pathname);
    assert.equal(response.status, 307);
    assert.equal(response.headers.get("location"), "/login");
  }
});
