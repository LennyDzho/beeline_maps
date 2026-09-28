import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const web = resolve(root, "apps/web");
const args = new Set(process.argv.slice(2));
if ([...args].some((arg) => !["--android", "--browser", "--help"].includes(arg))) {
  console.error("Usage: pnpm qa [--browser] [--android]"); process.exit(2);
}
if (args.has("--help")) {
  console.log("pnpm qa: build, typecheck, lint, all offline web/API/routing tests.\n--browser: isolated headless Playwright UI tests.\n--android: build APK, unit tests, lint, compile device tests; NEVER install/run them.\nResults: .tmp/qa/<run-id>/summary.json and separate logs. No real database/server is used.");
  process.exit(0);
}

const id = new Date().toISOString().replace(/[:.]/g, "-") + `-${process.pid}`;
const output = resolve(root, ".tmp/qa", id);
await mkdir(output, { recursive: true });
const steps = [];
const node = (name, parameters, cwd = root, requires = []) => ({ name, command: process.execPath, parameters, cwd, requires });
const tsc = resolve(root, "node_modules/typescript/bin/tsc");
steps.push({ name: "optimizer-python", command: process.env.OPTIMIZER_TEST_PYTHON ?? resolve(root, "algorithm-research/benchmark/.venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python"),
  parameters: ["-m", "unittest", "-v", "test_solver", "test_server"], cwd: resolve(root, "services/optimizer"), requires: [] });
steps.push(
  node("root-types", [tsc, "-p", "tsconfig.json", "--noEmit"]),
  node("web-types", [resolve(web, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.json", "--noEmit"], web),
  node("web-lint", [resolve(web, "node_modules/eslint/bin/eslint.js"), ".", "--ignore-pattern", "dist", "--ignore-pattern", ".next"], web),
  node("provider-build", [tsc, "-p", "packages/provider-contracts/tsconfig.build.json"]),
  node("routing-test-build", [tsc, "-p", "tsconfig.test.json"]),
  node("routing-tests", ["--test", "--test-reporter=tap", ...[
    "packages/provider-contracts/test/contracts.test.js", "packages/provider-contracts/test/regional-time.test.js", "apps/web/tests/route-scheduling.test.js",
    "apps/web/tests/two-gis-resilience.test.js", "apps/web/tests/planning-providers.test.js", "apps/web/tests/ortools-optimizer.test.js",
  ].map((file) => resolve(web, ".tmp/test-build", file))], root, ["routing-test-build"]),
  node("web-build", [resolve(web, "node_modules/vinext/dist/cli.js"), "build"], web, ["provider-build"]),
  node("web-api-tests", ["--test", "--test-concurrency=1", "--test-reporter=tap", ...[
    "rendered-html", "auth-flow", "login-form", "mobile-workflow", "media-validation", "startup-seed", "cold-start", "supported-optimizers-migration", "reports", "qualifications", "application-api", "regional-scheduling", "regional-migration", "work-catalog", "notifications", "manual-scheduling", "beeline-import", "plan-comparison", "optimizer-service", "beeline-planning", "planning-availability", "transport-profiles", "client-approvals", "brigade-equipment", "common-plan", "emergency", "route-geometry", "composite-report",
      "dataset-transition", "shared-catalog-migration", "result-storage", "work-order-guids",
    ].map((name) => `tests/${name}.test.mjs`)], web, ["web-build"]),
);
if (args.has("--browser")) steps.push(node("browser-tests", ["--test", "--test-reporter=tap", "tests/browser-workflows.test.mjs"], web, ["web-build"]));
if (args.has("--android")) steps.push({ name: "android-build-tests-lint", command: "powershell.exe",
  parameters: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", resolve(root, "apps/android/build.ps1"), "-CompileDeviceTests"], cwd: root,
  requires: [], unsupported: process.platform !== "win32" });

const results = [];
for (const step of steps) {
  const prerequisite = step.requires.find((name) => results.find((r) => r.name === name)?.status !== "passed");
  if (prerequisite || step.unsupported) {
    results.push({ name: step.name, status: "blocked", reason: prerequisite ? `Failed prerequisite: ${prerequisite}` : "Use native Gradle tasks on a non-Windows host" });
    continue;
  }
  console.log(`\n[QA] ${step.name}`);
  const logPath = resolve(output, `${step.name}.log`);
  const log = createWriteStream(logPath);
  const started = Date.now();
  const code = await new Promise((done) => {
    // Direct executable arguments, no shell expansion and no destructive scripts.
    const child = spawn(step.command, step.parameters, { cwd: step.cwd, env: process.env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (chunk) => { log.write(chunk); process.stdout.write(chunk); });
    child.stderr.on("data", (chunk) => { log.write(chunk); process.stderr.write(chunk); });
    child.on("error", (error) => { log.write(error.message + "\n"); console.error(error.message); });
    child.on("close", (exitCode) => done(exitCode ?? 1));
  });
  await new Promise((done) => log.end(done));
  results.push({ name: step.name, status: code === 0 ? "passed" : "failed", exitCode: code, durationMs: Date.now() - started, logPath });
}
const report = { runId: id, generatedAt: new Date().toISOString(), isolated: true,
  browserRequested: args.has("--browser"), androidRequested: args.has("--android"),
  status: results.every((r) => r.status === "passed") ? "passed" : "failed", results };
await writeFile(resolve(output, "summary.json"), JSON.stringify(report, null, 2) + "\n", "utf8");
console.log(`\n[QA] ${report.status.toUpperCase()}: ${resolve(output, "summary.json")}`);
for (const result of results) console.log(`  ${result.status}: ${result.name}`);
process.exitCode = report.status === "passed" ? 0 : 1;
