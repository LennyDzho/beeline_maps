"""Common arc-flow formulation for CP-SAT, SCIP and CBC. Static PRIMARY only.

Positive service durations eliminate disconnected cycles through time precedence.
Big-M values are derived per row from finite variable bounds, never arbitrary.
"""
import importlib.metadata
import json
import subprocess
import time
import re
from decimal import Decimal, ROUND_FLOOR
from pathlib import Path

from core.preflight import require_ready
from core.solution_model import dominating_weights


def eligible(j, w):
    return (j["divisionId"] == w["divisionId"] and j["requiredSkill"] in w["skills"]
        and (j.get("requiredTransportMode") is None or j["requiredTransportMode"] == w["transportMode"])
        and set(j.get("requiredQualifications", [])) <= set(w.get("qualifications", []))
        and set(j.get("requiredEquipment", [])) <= set(w.get("equipment", [])))


def solve(problem, policy, time_limit, seed, initial_solution=None, fixed_activities=None, *, engine):
    require_ready(problem)
    if policy != "PRIMARY" or problem.get("eventAt") is not None or problem.get("protectedActivities") or problem.get("fixedActivities") or fixed_activities or initial_solution:
        raise NotImplementedError("Reference formulation currently implements static PRIMARY")
    began = time.perf_counter()
    if engine == "cpsat":
        from ortools.sat.python import cp_model
        model = cp_model.CpModel()
        def var(name, lb=0, ub=1):
            return model.new_int_var(lb, ub, name)
        add = model.add
        expr_sum = cp_model.LinearExpr.sum
    elif engine == "scip":
        from pyscipopt import Model, quicksum
        model = Model()
        model.hideOutput()
        def var(name, lb=0, ub=1):
            return model.addVar(name, vtype="B" if lb == 0 and ub == 1 else "I", lb=lb, ub=ub)
        add = model.addCons
        expr_sum = quicksum
    elif engine == "cbc":
        import pulp
        model = pulp.LpProblem("TRSP", pulp.LpMinimize)
        def var(name, lb=0, ub=1):
            return pulp.LpVariable(name, lowBound=lb, upBound=ub, cat="Integer")
        def add(constraint):
            model.addConstraint(constraint)
        expr_sum = pulp.lpSum
    else:
        raise ValueError(engine)
    jobs, workers = problem["jobs"], problem["workers"]
    n, nw = len(jobs), len(workers)
    max_arc = max(d for matrix in problem["distanceMatrices"].values() for row in matrix.values() for d in row.values() if d is not None)
    distance_upper = n*max_arc
    weights = dominating_weights([n, nw, distance_upper])
    if n*weights[0] + nw*weights[1] + distance_upper >= 2**52:
        raise ValueError("Reference scalar would exceed safe exact-integer range for MIP doubles")
    lows = [max(j["windowStart"], j["releaseTime"]) for j in jobs]
    highs = [max(lows[i], j["windowEnd"]) for i, j in enumerate(jobs)]
    starts = [var(f"t_{i}", lows[i], highs[i]) for i in range(n)]
    initial = [(v, lows[i]) for i, v in enumerate(starts)]
    used = [var(f"u_{w}") for w in range(nw)]
    initial += [(v, 0) for v in used]
    assignments, arcs, lengths = {}, {}, []
    by_job = [[] for _ in jobs]
    for wi, w in enumerate(workers):
        av = max(w["availableAt"], w["shiftStart"])
        tmat, dmat = problem["travelTimeMatrices"][w["transportMode"]], problem["distanceMatrices"][w["transportMode"]]
        candidates = [i for i, j in enumerate(jobs) if eligible(j, w)
            and lows[i] <= j["windowEnd"] and lows[i]+j["serviceDuration"] <= w["shiftEnd"]]
        incoming, outgoing = {i: [] for i in candidates}, {i: [] for i in candidates}
        source_arcs, sink_arcs = [], []

        def add_arc(a, b, length):
            x = var(f"x_{wi}_{a}_{b}")
            arcs[wi, a, b] = x
            initial.append((x, 0))
            lengths.append(length*x)
            if a == -1:
                source_arcs.append(x)
            else:
                outgoing[a].append(x)
            if b == -2:
                sink_arcs.append(x)
            else:
                incoming[b].append(x)
            return x

        for i in candidates:
            job = jobs[i]
            y = var(f"y_{wi}_{i}")
            assignments[wi, i] = y
            by_job[i].append(y)
            initial.append((y, 0))
            t = tmat.get(w["startLocationId"], {}).get(job["locationId"])
            d = dmat.get(w["startLocationId"], {}).get(job["locationId"])
            if t is not None and d is not None and av+t <= highs[i]:
                x = add_arc(-1, i, d)
                big_m = max(0, av+t-lows[i])
                add(starts[i] >= av+t-big_m*(1-x))
            add_arc(i, -2, 0)
            big_m = max(0, highs[i]+job["serviceDuration"]-w["shiftEnd"])
            add(starts[i]+job["serviceDuration"] <= w["shiftEnd"]+big_m*(1-y))
        for i in candidates:
            for j in candidates:
                if i == j:
                    continue
                a, b = jobs[i]["locationId"], jobs[j]["locationId"]
                t, d = tmat.get(a, {}).get(b), dmat.get(a, {}).get(b)
                if t is None or d is None:
                    continue
                delta = jobs[i]["serviceDuration"]+t
                if lows[i]+delta > highs[j]:
                    continue
                x = add_arc(i, j, d)
                big_m = max(0, highs[i]+delta-lows[j])
                add(starts[j] >= starts[i]+delta-big_m*(1-x))
        add(expr_sum(source_arcs) == used[wi])
        add(expr_sum(sink_arcs) == used[wi])
        for i in candidates:
            add(expr_sum(incoming[i]) == assignments[wi, i])
            add(expr_sum(outgoing[i]) == assignments[wi, i])
    for candidates in by_job:
        if candidates:
            add(expr_sum(candidates) <= 1)
    objective = weights[0]*(n-expr_sum(list(assignments.values()))) + weights[1]*expr_sum(used) + expr_sum(lengths)
    build_ms = (time.perf_counter()-began)*1000
    search_started = time.perf_counter()
    if engine == "cpsat":
        model.minimize(objective)
        for variable, val in initial:
            model.add_hint(variable, val)
        solver = cp_model.CpSolver()
        solver.parameters.num_search_workers = 1
        solver.parameters.random_seed = seed
        solver.parameters.max_time_in_seconds = time_limit
        code = solver.solve(model)
        status = solver.status_name(code)
        has_solution = code in [cp_model.OPTIMAL, cp_model.FEASIBLE]
        value = solver.value
        obj = solver.objective_value if has_solution else None
        bound = solver.best_objective_bound
        version = importlib.metadata.version("ortools")
    elif engine == "scip":
        model.setObjective(objective, "minimize")
        model.setRealParam("limits/time", time_limit)
        model.setRealParam("limits/gap", 0.0)
        model.setIntParam("parallel/maxnthreads", 1)
        model.setIntParam("randomization/randomseedshift", seed)
        hint = model.createSol()
        for variable, val in initial:
            model.setSolVal(hint, variable, val)
        model.addSol(hint)
        model.optimize()
        status = str(model.getStatus())
        has_solution = model.getNSols() > 0
        value = model.getVal
        obj = model.getObjVal() if has_solution else None
        bound = model.getDualbound()
        version = ".".join(str(fn()) for fn in [model.getMajorVersion, model.getMinorVersion, model.getTechVersion])
    else:
        model.setObjective(objective)
        for variable, val in initial:
            variable.setInitialValue(val)
        command = pulp.PULP_CBC_CMD(msg=False)
        root = Path(__file__).resolve().parents[1]
        runtime_manifest = root / "registry/cbc-runtime.json"
        if runtime_manifest.exists():
            runtime_info = json.loads(runtime_manifest.read_text(encoding="utf-8"))
            command.path = str(root / runtime_info["executable"])
        else:
            runtime_info = {"version": "2.10.3"}
        scratch = Path(__file__).resolve().parents[1] / ".cache" / "cbc" / str(time.time_ns())
        scratch.mkdir(parents=True, exist_ok=True)
        vs, var_names, con_names, obj_name = model.writeMPS(str(scratch / "model.mps"), rename=1)
        command.writesol(str(scratch / "start.mst"), model, vs, var_names, con_names)
        # Explicit quit and a process watchdog prevent a native timed-stop
        # failure from blocking all remaining candidates. CBC's zero worker
        # threads means a single main thread, not unlimited parallelism.
        argv = [command.path, "model.mps", "-mips", "start.mst", "-sec", str(time_limit),
            "-timeMode", "cpu", "-threads", "0", "-randomSeed", str(seed), "-randomCbcSeed", str(seed),
            "-preprocess", "off", "-ratio", "0", "-solve", "-printingOptions", "all", "-solution", "result.sol", "-quit"]
        with (scratch / "cbc.log").open("w", encoding="utf-8") as log:
            try:
                native = subprocess.run(argv, cwd=scratch, stdout=log, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
                    timeout=max(30, 4*time_limit+5), creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            except subprocess.TimeoutExpired:
                raise RuntimeError(f"CBC external watchdog timeout; native log: {scratch / 'cbc.log'}") from None
        if native.returncode or not (scratch / "result.sol").exists():
            raise RuntimeError(f"CBC native exit {native.returncode}; native log: {scratch / 'cbc.log'}")
        native_status, values, reduced_costs, shadow_prices, slacks, solution_status = command.readsol_MPS(
            str(scratch / "result.sol"), model, vs, var_names, con_names, obj_name)
        model.assignVarsVals(values)
        model.assignVarsDj(reduced_costs)
        model.assignConsPi(shadow_prices)
        model.assignConsSlack(slacks, activity=True)
        model.assignStatus(native_status, solution_status)
        status = pulp.LpStatus[model.status] + "/" + pulp.LpSolution[model.sol_status]
        has_solution = model.sol_status in [pulp.LpSolutionOptimal, pulp.LpSolutionIntegerFeasible]
        value = lambda variable: variable.value()
        obj = pulp.value(model.objective) if has_solution else None
        bound = None
        log_text = (scratch / "cbc.log").read_text(encoding="utf-8", errors="replace")
        printed_bound = re.findall(r"^Lower bound:\s*([-+0-9.eE]+)", log_text, re.M)
        if status == "Optimal/Optimal Solution Found" and obj is not None:
            bound = obj
        elif printed_bound:
            # MPS omits PuLP's constant N*drop_weight. CBC prints a rounded
            # bound, so subtract one unit of its last printed decimal place
            # before rounding down. This preserves a conservative integer LB.
            printed = Decimal(printed_bound[-1])
            uncertainty = Decimal(10) ** printed.as_tuple().exponent
            bound = int((printed-uncertainty).to_integral_value(rounding=ROUND_FLOOR)) + n*weights[0]
        version = runtime_info["version"]
    search_ms = (time.perf_counter()-search_started)*1000
    gap = abs(obj-bound)/max(abs(obj), 1) if obj is not None and bound is not None and abs(bound) < 1e19 else None
    common = {"seed": seed, "solverVersion": version, "solverObjective": obj,
        "runtime": {"solverWallTimeMs": (time.perf_counter()-began)*1000, "modelBuildTimeMs": build_ms, "searchTimeMs": search_ms},
        "bestBound": bound, "optimalityGap": gap,
        "rawDiagnostics": {"nativeStatus": status, "weights": weights, "arcVariables": len(arcs),
            "cbcParameters": {"threads": 0, "timeMode": "cpu", "preprocess": "off", "relativeGap": 0} if engine == "cbc" else None,
            "cbcLogFile": str(scratch / "cbc.log") if engine == "cbc" else None,
            "cbcBoundSource": "Printed lower bound conservatively rounded down, corrected for MPS omitted objective constant; optimal status uses proved objective" if engine == "cbc" else None,
            "distanceUpperBoundMetres": distance_upper, "boundScale": "native proven scalar; never compare across solvers",
            "initialSolution": "trivial empty feasible plan, not another optimizer's output"}}
    if not has_solution:
        return {**common, "status": "NO_SOLUTION_FOUND", "routes": [], "unassigned": [j["id"] for j in jobs]}
    routes, assigned = [], set()
    for wi, w in enumerate(workers):
        selected = {a: b for (wk, a, b), x in arcs.items() if wk == wi and value(x) > 0.5}
        if -1 not in selected:
            continue
        next_node, seen, visits = selected[-1], set(), []
        while next_node != -2:
            if next_node in seen or next_node not in selected:
                raise RuntimeError("Native incumbent does not form a complete open route")
            seen.add(next_node)
            job = jobs[next_node]
            start = round(value(starts[next_node]))
            visits.append({"jobId": job["id"], "start": start, "finish": start+job["serviceDuration"]})
            assigned.add(job["id"])
            next_node = selected[next_node]
        routes.append({"workerId": w["id"], "startLocationId": w["startLocationId"],
            "departure": max(w["shiftStart"], w["availableAt"]), "visits": visits})
    return {**common, "status": "OPTIMAL" if status.lower() == "optimal" or status == "Optimal/Optimal Solution Found" else "FEASIBLE",
        "routes": routes, "unassigned": [j["id"] for j in jobs if j["id"] not in assigned]}
