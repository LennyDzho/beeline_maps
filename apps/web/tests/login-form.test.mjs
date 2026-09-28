import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const moduleUrl = (code) => `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;
const hooks = moduleUrl(`
  export function useState(initial) {
    const state = globalThis[Symbol.for('mmi.test.login-hooks')].states;
    const index = state.length;
    state.push(initial);
    return [initial, value => { state[index] = value; }];
  }
  export function useRef(initial) { return { current: initial }; }
`);
const jsx = moduleUrl("const element = (type, props) => ({ type, props }); export { element as jsx, element as jsxs };");
const icon = moduleUrl("export default function Icon() { return null; }");
const code = ts.transpileModule(await readFile(new URL("../app/login/login-form.tsx", import.meta.url), "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX },
}).outputText.replaceAll('from "react"', `from "${hooks}"`)
  .replaceAll('from "react/jsx-runtime"', `from "${jsx}"`)
  .replaceAll('from "@/app/components/material-icon"', `from "${icon}"`);
const { default: LoginForm } = await import(moduleUrl(code));

function fixture(t, fetcher) {
  const originalFetch = globalThis.fetch;
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const states = [];
  const navigations = [];
  globalThis[Symbol.for("mmi.test.login-hooks")] = { states };
  globalThis.fetch = fetcher;
  globalThis.window = { location: { replace: (path) => navigations.push(path) } };
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow); else delete globalThis.window;
    delete globalThis[Symbol.for("mmi.test.login-hooks")];
  });
  const form = LoginForm();
  return { states, navigations, submit: () => form.props.onSubmit({ preventDefault() {} }) };
}

test("login submits once and remains disabled until history-replacing navigation completes", async (t) => {
  let calls = 0;
  let finish;
  const pending = new Promise((resolve) => { finish = resolve; });
  const f = fixture(t, async (url, init) => {
    calls++;
    assert.equal(url, "/api/auth/login");
    assert.equal(init.credentials, "same-origin");
    assert.equal(init.cache, "no-store");
    await pending;
    return Response.json({ ok: true });
  });
  const first = f.submit();
  await f.submit();
  assert.equal(calls, 1);
  assert.equal(f.states[4], true);
  finish();
  await first;
  assert.deepEqual(f.navigations, ["/"]);
  assert.equal(f.states[4], true);
  await f.submit();
  assert.equal(calls, 1);
});

test("invalid credentials stay on the form and allow a corrected attempt", async (t) => {
  let calls = 0;
  const f = fixture(t, async () => ++calls === 1
    ? Response.json({ message: "Неверный email или пароль." }, { status: 401 })
    : Response.json({ ok: true }));
  await f.submit();
  assert.equal(f.states[3], "Неверный email или пароль.");
  assert.equal(f.states[4], false);
  assert.deepEqual(f.navigations, []);
  await f.submit();
  assert.equal(calls, 2);
  assert.deepEqual(f.navigations, ["/"]);
});

test("network failure does not navigate or lock the login form permanently", async (t) => {
  const f = fixture(t, async () => { throw new Error("offline"); });
  await f.submit();
  assert.equal(f.states[4], false);
  assert.match(f.states[3], /Нет связи с сервером/);
  assert.deepEqual(f.navigations, []);
});
