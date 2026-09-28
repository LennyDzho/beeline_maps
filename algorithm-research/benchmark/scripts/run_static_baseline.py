"""Initial real-input runs with preflight and independent validation for every run."""
import argparse
import copy
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from runner import run_once, adapter_source
from core.problem_model import fingerprint

sys.stdout.reconfigure(encoding="utf-8")


def subset(problem, scope):
    p = copy.deepcopy(problem)
    if scope.startswith("exact-"):
        import random
        shuffled = list(p["jobs"])
        random.Random(20260917).shuffle(shuffled)
        p["jobs"] = shuffled[:int(scope.split("-")[1])]
        p["referenceSelectionSeed"] = 20260917
    elif scope != "all":
        p["workers"] = [w for w in p["workers"] if w["divisionId"] == scope]
        p["jobs"] = [j for j in p["jobs"] if j["divisionId"] == scope]
    p["id"] += ":" + scope
    return p


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--solver", default="ortools_routing")
    parser.add_argument("--budgets", type=float, nargs="+", default=[1, 5])
    parser.add_argument("--seeds", type=int, nargs="+", default=[1])
    parser.add_argument("--scopes", nargs="+", default=["east", "southeast", "southcentral", "all"])
    args = parser.parse_args()
    original = json.loads((ROOT / "datasets/problem.json").read_text(encoding="utf-8"))
    for scope in args.scopes:
        p = subset(original, scope)
        for budget in args.budgets:
            for seed in args.seeds:
                adapter_code = adapter_source(args.solver)
                tag = fingerprint({"problem": p, "solver": args.solver, "budget": budget, "seed": seed,
                    "adapter": adapter_code})[:16]
                path = ROOT / f"results/raw/baseline-{args.solver}-{scope}-{budget:g}s-{seed}-{tag}.json"
                if path.exists():
                    record = json.loads(path.read_text(encoding="utf-8"))
                else:
                    record = run_once(p, args.solver, "PRIMARY", budget, seed)
                    record["scope"] = scope
                    record["experimentStage"] = "STATIC_BASELINE_NOT_FINAL_COMPARISON"
                    path.write_text(json.dumps(record, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
                m = record.get("metrics") or {}
                print(json.dumps({"solver": args.solver, "scope": scope, "budget": budget, "seed": seed,
                    "status": record["status"], "served": m.get("served"), "workers": m.get("workersUsed"),
                    "distanceKm": m.get("distanceKm"), "hardViolations": m.get("hardViolations")}, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
