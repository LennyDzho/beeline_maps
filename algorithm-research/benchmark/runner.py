"""One-run entry point. Data and adapter readiness are checked before execution."""

import argparse
import importlib
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

from core.metrics import calculate_metrics
from core.preflight import check_problem
from core.problem_model import fingerprint

ROOT = Path(__file__).resolve().parent
IMPLEMENTED = {"ortools_routing", "pyvrp", "cpsat", "scip", "cbc", "alns", "vroom", "jsprit", "timefold", "choco"}


def adapter_source(solver, extended=False):
    source = (ROOT / f"adapters/{solver}.py").read_text(encoding="utf-8")
    if solver in {"cpsat", "scip", "cbc", "vroom"}:
        source += (ROOT / "adapters/linear_reference.py").read_text(encoding="utf-8")
    if solver in {"jsprit", "timefold", "choco"}:
        source += (ROOT / "adapters/java_bridge.py").read_text(encoding="utf-8")
        source += (ROOT / "adapters/java/pom.xml").read_text(encoding="utf-8")
        for path in sorted((ROOT / "adapters/java/src").rglob("*.java")):
            source += path.read_text(encoding="utf-8")
    if solver == "alns" and extended:
        source += (ROOT / "adapters/alns_extended.py").read_text(encoding="utf-8")
    if solver == "timefold" and extended:
        source += (ROOT / "adapters/timefold_extended.py").read_text(encoding="utf-8")
    if solver == "ortools_routing" and extended:
        source += (ROOT / "adapters/ortools_routing_extended.py").read_text(encoding="utf-8")
        source += (ROOT / "adapters/linear_reference.py").read_text(encoding="utf-8")
    return source


def run_once(problem, solver, policy, time_limit, seed):
    preflight = check_problem(problem)
    envelope = {"solver": solver, "dataset": problem["id"], "policy": policy, "timeLimitSec": time_limit,
                "seed": seed, "timestamp": datetime.now(timezone.utc).isoformat(),
                "datasetVersion": problem["datasetVersion"], "matrixVersion": problem["matrixVersion"],
                "problemFingerprint": fingerprint(problem), "preflight": preflight}
    if preflight["status"] != "READY":
        return {**envelope, "status": "BLOCKED_DATA", "solution": None, "metrics": None}
    if solver not in IMPLEMENTED:
        return {**envelope, "status": "ADAPTER_NOT_IMPLEMENTED", "solution": None, "metrics": None}
    extended = policy != "PRIMARY" or problem.get("eventAt") is not None or bool(problem.get("fixedActivities")) or bool(problem.get("protectedActivities"))
    if extended and solver not in {"alns", "timefold", "ortools_routing"}:
        return {**envelope, "status": "ADAPTER_NOT_IMPLEMENTED", "reason": "Only the static PRIMARY adapter is currently implemented", "solution": None, "metrics": None}
    adapter = importlib.import_module("adapters." + (solver + "_extended" if extended else solver))
    versions_path = ROOT / "results/installation_smoke.json"
    if versions_path.exists():
        installed = {r["solver"]: r.get("solverVersion") for r in json.loads(versions_path.read_text(encoding="utf-8"))}
        envelope["solverVersion"] = installed.get(solver)
    envelope["adapterVersion"] = fingerprint(adapter_source(solver,extended))
    envelope["validatorVersion"] = fingerprint((ROOT / "core/validator.py").read_text(encoding="utf-8"))
    envelope["metricsVersion"] = fingerprint((ROOT / "core/metrics.py").read_text(encoding="utf-8"))
    try:
        solution = adapter.solve(problem, policy, time_limit, seed)
    except Exception as error:
        return {**envelope, "status": "RUNTIME_ERROR", "solution": None, "metrics": None,
            "error": {"type": type(error).__name__, "message": str(error)}}
    if solution["status"] == "NO_SOLUTION_FOUND":
        return {**envelope, "status": "NO_SOLUTION_FOUND", "solution": solution, "metrics": None}
    metrics = calculate_metrics(problem, solution)
    if metrics.get("eligibleForComparison"):
        from core.replanning import change_log, explain_unassigned
        solution["unassignedExplanations"] = explain_unassigned(problem, solution)
        if problem.get("previousSolution") is not None:
            # History compares the whole day. Committed jobs excluded from
            # optimization must not appear as newly removed assignments.
            by_worker = {r["workerId"]: {"workerId": r["workerId"], "visits": list(r["visits"])} for r in solution["routes"]}
            for activity in problem.get("pastActivities", []):
                route = by_worker.setdefault(activity["workerId"], {"workerId": activity["workerId"], "visits": []})
                route["visits"].append({k: activity[k] for k in ["jobId", "start", "finish"]})
            solution["changeLog"] = change_log(problem["previousSolution"], {"routes": list(by_worker.values())}, problem.get("event", {}).get("type", "replan"), problem.get("assignmentHistory"))
    return {**envelope, "status": metrics["status"], "solution": solution, "metrics": metrics}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--problem", default=str(ROOT / "datasets/problem.json"))
    parser.add_argument("--solver", required=True)
    parser.add_argument("--policy", default="PRIMARY", choices=["PRIMARY", "POLICY_FAST_RESPONSE", "POLICY_MIN_STAFF"])
    parser.add_argument("--time-limit", type=float, default=1)
    parser.add_argument("--seed", type=int, default=1)
    parser.add_argument("--output", help="Optional output file inside the research results directory")
    args = parser.parse_args()
    if args.time_limit <= 0:
        parser.error("Time limit must be positive")
    ids = {c["id"] for c in json.loads((ROOT / "registry/candidates.json").read_text(encoding="utf-8"))}
    if args.solver not in ids:
        parser.error("Unknown solver")
    problem = json.loads(Path(args.problem).read_text(encoding="utf-8"))
    record = run_once(problem, args.solver, args.policy, args.time_limit, args.seed)
    run_id = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%f") + "-" + args.solver
    path = Path(args.output).resolve() if args.output else ROOT / "results/raw" / (run_id + ".json")
    if not path.resolve().is_relative_to((ROOT / "results").resolve()):
        parser.error("Output must stay inside benchmark/results")
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(record, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(path)
    print(json.dumps({"status": record["status"], "resultFile": str(path)}, ensure_ascii=False))
    if record["status"] in {"BLOCKED_DATA", "ADAPTER_NOT_IMPLEMENTED"}:
        sys.exit(2)


if __name__ == "__main__":
    main()
