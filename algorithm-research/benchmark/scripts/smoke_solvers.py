"""Installation smoke checks only. Not a benchmark of the case dataset."""

import importlib.metadata
import argparse
import json
import time
import traceback
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT), str(ROOT / "tests")]


def routing_binding(solver):
    import importlib
    from test_core import fixture
    from core.metrics import calculate_metrics
    p, _ = fixture()
    result = importlib.import_module("adapters."+solver).solve(p,"PRIMARY",1,1)
    metrics = calculate_metrics(p,result)
    assert metrics["hardViolations"] == 0 and metrics["served"] == 1 and metrics["distanceMetres"] == 1200
    return {"solverVersion":result["solverVersion"],"fixture":"one open-route job with explicit window, skills, shift and matrix", "actual":metrics["distanceMetres"]}


def vroom(): return routing_binding("vroom")
def jsprit(): return routing_binding("jsprit")
def timefold(): return routing_binding("timefold")
def choco(): return routing_binding("choco")


def ortools_routing():
    from ortools.constraint_solver import pywrapcp
    manager = pywrapcp.RoutingIndexManager(2, 1, 0)
    routing = pywrapcp.RoutingModel(manager)
    transit = routing.RegisterTransitCallback(lambda a, b: int(manager.IndexToNode(a) != manager.IndexToNode(b)))
    routing.SetArcCostEvaluatorOfAllVehicles(transit)
    params = pywrapcp.DefaultRoutingSearchParameters()
    params.time_limit.seconds = 1
    result = routing.SolveWithParameters(params)
    assert result is not None and result.ObjectiveValue() == 2
    return {"solverVersion": importlib.metadata.version("ortools"), "fixture": "two-node closed tour, known cost 2", "actual": 2}


def cpsat():
    from ortools.sat.python import cp_model
    model = cp_model.CpModel()
    x = model.NewIntVar(0, 10, "x")
    model.Add(x >= 1)
    model.Minimize(x)
    solver = cp_model.CpSolver()
    solver.parameters.num_search_workers = 1
    solver.parameters.random_seed = 1
    solver.parameters.max_time_in_seconds = 1
    status = solver.Solve(model)
    assert status == cp_model.OPTIMAL and solver.Value(x) == 1
    return {"solverVersion": importlib.metadata.version("ortools"), "fixture": "min integer x, x>=1", "actual": 1}


def scip():
    from pyscipopt import Model
    model = Model()
    model.hideOutput()
    x = model.addVar("x", vtype="I", lb=0, ub=10)
    model.addCons(x >= 1)
    model.setObjective(x, "minimize")
    model.setRealParam("limits/time", 1)
    model.optimize()
    assert str(model.getStatus()) == "optimal" and round(model.getVal(x)) == 1
    version = ".".join(str(fn()) for fn in [model.getMajorVersion, model.getMinorVersion, model.getTechVersion])
    return {"solverVersion": version, "packageVersion": importlib.metadata.version("pyscipopt"), "fixture": "min integer x, x>=1", "actual": 1}


def cbc():
    import subprocess
    import re
    import pulp
    model = pulp.LpProblem("installation_smoke", pulp.LpMinimize)
    x = pulp.LpVariable("x", 0, 10, cat=pulp.LpInteger)
    model += x
    model += x >= 1
    command = pulp.PULP_CBC_CMD(msg=False, timeLimit=1, threads=1)
    runtime_manifest = ROOT / "registry/cbc-runtime.json"
    if runtime_manifest.exists():
        command.path = str(ROOT / json.loads(runtime_manifest.read_text(encoding="utf-8"))["executable"])
    status = model.solve(command)
    assert status == pulp.LpStatusOptimal and round(x.value()) == 1
    text = subprocess.run([command.path, "-stop"], capture_output=True, text=True, encoding="utf-8", errors="replace", check=True).stdout
    version = re.search(r"Version:\s*(\S+)", text).group(1)
    return {"solverVersion": version, "packageVersion": importlib.metadata.version("pulp"), "fixture": "min integer x, x>=1", "actual": 1}


def pyvrp():
    from pyvrp import Model
    from pyvrp.stop import MaxIterations
    model = Model()
    a, b = model.add_location(0, 0), model.add_location(1, 0)
    depot = model.add_depot(a)
    model.add_client(b, delivery=1)
    model.add_vehicle_type(num_available=1, capacity=2, start_depot=depot, end_depot=depot)
    model.add_edge(a, b, distance=1, duration=1)
    model.add_edge(b, a, distance=1, duration=1)
    result = model.solve(MaxIterations(10), seed=1, display=False)
    assert result.is_feasible() and result.cost() == 2
    return {"solverVersion": importlib.metadata.version("pyvrp"), "fixture": "two-node closed tour, known cost 2", "actual": result.cost()}


def alns():
    import numpy as np
    from alns import ALNS
    from alns.accept import HillClimbing
    from alns.select import RandomSelect
    from alns.stop import MaxIterations

    class State:
        def __init__(self, x):
            self.x = x

        def objective(self):
            return self.x

    solver = ALNS(np.random.default_rng(1))
    solver.add_destroy_operator(lambda state, rng: State(max(0, state.x - 1)))
    solver.add_repair_operator(lambda state, rng: state)
    result = solver.iterate(State(10), RandomSelect(1, 1), HillClimbing(), MaxIterations(15))
    assert result.best_state.objective() == 0
    return {"solverVersion": importlib.metadata.version("alns"), "fixture": "decrement-to-zero example with fixed seed", "actual": 0}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--solver")
    args = parser.parse_args()
    candidates = json.loads((ROOT / "registry/candidates.json").read_text(encoding="utf-8"))
    path = ROOT / "results/installation_smoke.json"
    result = json.loads(path.read_text(encoding="utf-8")) if args.solver and path.exists() else []
    for candidate in candidates:
        sid = candidate["id"]
        if args.solver and sid != args.solver:
            continue
        row = {"solver": sid, "timestamp": datetime.now(timezone.utc).isoformat(),
               "phase": "INSTALLATION_SMOKE", "status": "NOT_RUN", "reason": None}
        function = globals().get(sid)
        if function is None:
            row["reason"] = "Runtime/build and smoke adapter have not been prepared"
        else:
            started = time.perf_counter()
            try:
                row.update(function(), status="PASS", dataPreflight="COMPLETE_EXPLICIT_TINY_FIXTURE")
            except Exception as exc:
                row.update(status="FAIL", reason=type(exc).__name__ + ": " + str(exc), traceback=traceback.format_exc())
            row["installationCheckWallTimeMs"] = (time.perf_counter() - started) * 1000
        result = [old for old in result if old["solver"] != sid] + [row]
        print(sid, row["status"], row.get("solverVersion", ""), row.get("reason") or "", flush=True)
        (ROOT / "results/installation_smoke.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
