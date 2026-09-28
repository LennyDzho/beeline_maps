import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import test from "node:test";
import { evaluatePlan, ProviderError, type PlanningProblem, type TravelTimeMatrixPort } from "@mmi/provider-contracts";
import { OrToolsOptimizationEngine, type SolverInput } from "../app/lib/server/planning/ortools-optimizer.js";

import { PyVrpOptimizationEngine } from "../app/lib/server/planning/pyvrp-optimizer.js";

const time = (seconds:number) => new Date(Date.parse("2026-08-17T06:00:00Z")+seconds*1000).toISOString();
function problem(): PlanningProblem { return { id:"integration", horizon:{startAt:time(0),endAt:time(3600)}, profile:{mode:"driving"}, resources:[],objectives:[],
  jobs:[0,1].map(i => ({id:`J${i}`,location:{lat:55.75+i*.01,lon:37.6},serviceDurationSeconds:300,state:"new",changePolicy:"free",hardTimeWindows:[{startAt:time(0),endAt:time(3300)}],requiredSkills:["hd:BK:one","hd:BK:two"]})),
  agents:["A","B"].map(id => ({id,skills:["hd:BK:one","hd:BK:two"],fixedResourceTags:[],shifts:[{id:`S-${id}`,window:{startAt:time(0),endAt:time(3600)},startLocation:{lat:55.7,lon:37.6}}]})) }; }
const matrix: TravelTimeMatrixPort = { providerId:"fixture", async calculate(request) { return {meta:{providerId:"fixture",receivedAt:time(0),cache:"bypass"},data:{originIds:request.origins.map(p=>p.id),destinationIds:request.destinations.map(p=>p.id),cells:request.origins.flatMap(a=>request.destinations.map(b=>({status:"ok" as const,originId:a.id,destinationId:b.id,durationSeconds:a.id===b.id?0:60,distanceMeters:a.id===b.id?0:100})))}}; } };
const python = process.env.OPTIMIZER_TEST_PYTHON ?? resolve("algorithm-research/benchmark/.venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
const realSolver: typeof fetch = async (_url, options) => {
  const input = JSON.parse(String(options?.body)) as SolverInput;
  input.timeLimitMs=150;
  return Response.json(JSON.parse(execFileSync(python,[resolve("services/optimizer/solver.py")],{input:JSON.stringify(input),encoding:"utf8",timeout:15000,windowsHide:true})));
};

for (const [engineName, Engine] of [["ortools", OrToolsOptimizationEngine], ["pyvrp", PyVrpOptimizationEngine]] as const) {
test(`${engineName} application contract uses the real library and independently validates road metrics, all HD and start windows`, async () => {
  const p=problem();
  const result=await new Engine(matrix,{url:"http://127.0.0.1:8765"},realSolver).optimize(p);
  assert.equal(result.unassigned.length,0); assert.equal(result.routes.length,1);
  assert.equal(result.routes[0]!.totalDistanceMeters,200);
  assert.equal(result.routes[0]!.endLeg,undefined);
  assert.equal(evaluatePlan(p,result).validation.valid,true);
  assert.match(result.diagnostics.engineId,engineName === "ortools" ? /ortools=9\.15/ : /pyvrp=0\.14/);
  const engaged={...p,agents:p.agents.map(a=>({...a,alreadyEngaged:a.id==='B'}))};
  const reused=await new Engine(matrix,{url:"http://127.0.0.1:8765"},realSolver).optimize(engaged);
  assert.deepEqual(reused.routes.map(r=>r.agentId),['B']);
  const incomplete={...p,agents:p.agents.map(a=>({...a,skills:["hd:BK:one"]}))};
  const dropped=await new Engine(matrix,{url:"http://127.0.0.1:8765"},realSolver).optimize(incomplete);
  assert.equal(dropped.unassigned.length,2); assert.ok(dropped.unassigned.every(j=>j.reason === "no_qualified_agent"));
});

test(`${engineName}: the selected emergency policy changes staffing without losing coverage`, async () => {
  const p=problem();
  const withEmergency={...p,jobs:[{...p.jobs[0]!,serviceDurationSeconds:600,requiredSkills:["only:A"],hardTimeWindows:[{startAt:time(60),endAt:time(60)}]}, {...p.jobs[1]!,isEmergency:true,releaseAt:time(60)}],agents:p.agents.map(a=>({...a,skills:[...a.skills,...a.id === "A" ? ["only:A"] : []]}))};
  const fast=await new Engine(matrix,{url:"http://127.0.0.1:8765",policy:"emergency_fast/v1"},realSolver).optimize(withEmergency);
  const staff=await new Engine(matrix,{url:"http://127.0.0.1:8765",policy:"emergency_staff/v1"},realSolver).optimize(withEmergency);
  assert.equal(fast.routes.length,2); assert.equal(staff.routes.length,1);
  assert.equal(fast.unassigned.length+staff.unassigned.length,0);
  assert.equal(fast.routes.flatMap(r=>r.visits).find(v=>v.jobId === "J1")!.serviceStartAt,time(60));
});

test(`${engineName}: a client-confirmed appointment may be proposed elsewhere but remains pending approval`, async () => {
  const p=problem();
  const protectedProblem: PlanningProblem={...p,jobs:[{...p.jobs[0]!,state:"client_confirmed",changePolicy:"dispatcher_approval_required",
    baseline:{agentId:"inactive",sequence:1,arrivalAt:time(1200),serviceStartAt:time(1200),serviceEndAt:time(1500)}}]};
  const result=await new Engine(matrix,{url:"http://127.0.0.1:8765"},realSolver).optimize(protectedProblem);
  assert.equal(result.status,"requires_approval");
  assert.deepEqual(result.approvals.map(a=>a.jobId),["J0"]);
  assert.equal(evaluatePlan(protectedProblem,result).validation.valid,true);
  assert.ok(evaluatePlan(protectedProblem,{...result,status:"ready",approvals:[]}).validation.issues.some(i=>i.code==="APPROVAL_REQUIRED"));
});

test(`${engineName}: departed brigades require the entire equipment set; a brigade still at the office can collect it`,async()=>{
  const p=problem();
  const equipped:PlanningProblem={...p,jobs:p.jobs.map((job,i)=>({...job,requiredEquipmentIds:i?["tester"]:["tester","ladder"]})),
    agents:p.agents.map(agent=>({...agent,availableEquipmentIds:agent.id==='A'?["tester"]:["ladder"]}))};
  const engine=new Engine(matrix,{url:"http://127.0.0.1:8765"},realSolver);
  const plan=await engine.optimize(equipped);assert.deepEqual(plan.unassigned.map(j=>j.jobId),['J0']);assert.equal(plan.routes[0]!.agentId,'A');
  const forged={...plan,routes:plan.routes.map(route=>({...route,agentId:'B',shiftId:'S-B'}))};
  assert.ok(evaluatePlan(equipped,forged).validation.issues.some(i=>i.code==='EQUIPMENT_MISMATCH'));
  const atOffice:PlanningProblem={...equipped,agents:[equipped.agents[0]!,p.agents[1]!]};
  assert.equal((await engine.optimize(atOffice)).unassigned.length,0);
});

test(`${engineName}: unconfigured, unavailable or malformed solver responses never fall back to another engine`, async () => {
  await assert.rejects(new Engine(matrix).optimize(problem()), /OPTIMIZER_SERVICE_URL/);
  await assert.rejects(new Engine(matrix,{url:"https://private.example"}).optimize(problem()), /токен/);
  for (const response of [Response.json({}, {status:503}),Response.json({version:1,policy:"emergency_fast/v1",status:"feasible",routes:[],unassigned:[]})]) {
    await assert.rejects(new Engine(matrix,{url:"http://localhost:8765"},async()=>response).optimize(problem()), error=>error instanceof ProviderError);
  }
});

test(`${engineName}: the worker-compatible transport rejects redirects without forwarding the solver token`, async () => {
  let calls = 0;
  const fetcher: typeof fetch = async (_url, options) => {
    calls++;
    assert.equal(options?.redirect, "manual");
    return new Response(null, { status: 302, headers: { Location: "https://other.example/solve" } });
  };
  await assert.rejects(new Engine(matrix, { url: "https://private.example", token: "fixture-only-token" }, fetcher).optimize(problem()), /HTTP 302/);
  assert.equal(calls, 1);
});

test(`${engineName}: a forged schedule, duplicate stop or wrong policy is rejected while road distances come only from the app matrix`, async () => {
  const engine = (edit: (output: Record<string,unknown>)=>void) => new Engine(matrix,{url:"http://localhost:8765"},async(url,options)=>{
    const output=await (await realSolver(url,options)).json() as Record<string,unknown>; edit(output); return Response.json(output);
  });
  await assert.rejects(engine(output=>{output.policy="emergency_staff/v1";}).optimize(problem()),/политику/);
  await assert.rejects(engine(output=>{const routes=output.routes as {visits:{start:number}[]}[]; routes[0]!.visits[0]!.start=3599;}).optimize(problem()),/Проверка отклонила/);
  await assert.rejects(engine(output=>{const routes=output.routes as {visits:unknown[]}[]; routes[0]!.visits.push(routes[0]!.visits[0]);}).optimize(problem()),/Проверка отклонила/);
});

  test(`${engineName}: rejects a response from the wrong optimization engine`, async () => {
    const engine = new Engine(matrix,{url:"http://localhost:8765"},async(url, options)=>{
      const output = await (await realSolver(url,options)).json();
      return Response.json({...output, engine:engineName === "ortools" ? "pyvrp" : "ortools"});
    });
    await assert.rejects(engine.optimize(problem()), /другого метода/);
  });
}
