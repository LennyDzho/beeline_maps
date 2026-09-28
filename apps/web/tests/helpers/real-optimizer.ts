import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import type { SolverInput } from "../../app/lib/server/planning/service-optimizer.js";

/** An isolated solver process: no live server, database or external roads. */
export const realOptimizer: typeof fetch = async (_url, options) => {
  const input = JSON.parse(String(options?.body)) as SolverInput;
  const python = process.env.OPTIMIZER_TEST_PYTHON ?? resolve("algorithm-research/benchmark/.venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
  return Response.json(JSON.parse(execFileSync(python, [resolve("services/optimizer/solver.py")], {
    input:JSON.stringify({...input,timeLimitMs:300}),encoding:"utf8",timeout:15000,windowsHide:true,
  })));
};
