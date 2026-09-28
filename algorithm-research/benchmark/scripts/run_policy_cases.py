"""Measured emergency policies and five common remaining-day scenarios."""
import argparse
import json
import sys
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
from core.preflight import check_problem
from core.problem_model import fingerprint
from runner import adapter_source
from scripts.run_campaign import measured_run,save


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--solvers",nargs="+",default=["alns"])
    parser.add_argument("--budget",type=float,default=5)
    parser.add_argument("--seeds",type=int,nargs="+",default=[1])
    args=parser.parse_args()
    cases={"initial":json.loads((ROOT/"datasets/problem.json").read_text(encoding="utf-8"))}
    dynamic_folder="dynamic-hd-v2" if cases["initial"].get("competencyModel") else "dynamic-v1"
    for name in ["new_emergency","cancellation","worker_unavailability","manual_assignment","manual_time"]:
        cases[name]=json.loads((ROOT/f"datasets/{dynamic_folder}/{name}.json").read_text(encoding="utf-8"))
    for name,p in cases.items():
        policies=["POLICY_FAST_RESPONSE","POLICY_MIN_STAFF"] if name=="initial" else ["PRIMARY","POLICY_FAST_RESPONSE","POLICY_MIN_STAFF"]
        for solver in args.solvers:
            for policy in policies:
                for seed in args.seeds:
                    audit=check_problem(p)
                    if audit["status"]!="READY": raise RuntimeError(audit)
                    tag=fingerprint({"p":p,"solver":solver,"policy":policy,"budget":args.budget,"seed":seed,"source":adapter_source(solver,True),
                        "metrics":(ROOT/"core/metrics.py").read_text(encoding="utf-8"),
                        "integration":(ROOT/"runner.py").read_text(encoding="utf-8")+(ROOT/"core/replanning.py").read_text(encoding="utf-8")})[:16]
                    path=ROOT/f"results/raw/policy-{solver}-{name}-{policy}-{args.budget:g}s-{seed}-{tag}.json"
                    if path.exists(): r=json.loads(path.read_text(encoding="utf-8"))
                    else:
                        r=measured_run(p,solver,args.budget,seed,path,policy)
                        r.update(scope=name,experimentStage="POLICIES_AND_DYNAMIC_CONTROL",scenarioFile="datasets/problem.json" if name=="initial" else f"datasets/{dynamic_folder}/{name}.json")
                        save(path,r)
                    m=r.get("metrics") or {}
                    print(json.dumps({"solver":solver,"case":name,"policy":policy,"status":r["status"],"served":m.get("served"),
                        "jobsTotal":m.get("jobsTotal"),"workers":m.get("workersUsed"),"meanResponseDelay":m.get("meanResponseDelay"),
                        "hardViolations":m.get("hardViolations")}),flush=True)


if __name__=="__main__":main()
