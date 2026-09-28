"""Serial measured scale runs on exactly the same synthetic instances."""
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
    parser.add_argument("--solvers",nargs="+",required=True)
    parser.add_argument("--budgets",nargs="+",type=float,default=[15])
    parser.add_argument("--sizes",nargs="+",type=int,default=[500,1000])
    parser.add_argument("--seeds",nargs="+",type=int,default=[1])
    args=parser.parse_args()
    for size in args.sizes:
        p=json.loads((ROOT/f"datasets/scaling-hd-v2/{size}.json").read_text(encoding="utf-8"))
        for budget in args.budgets:
            for solver in args.solvers:
                for seed in args.seeds:
                    audit=check_problem(p)
                    if audit["status"]!="READY":raise RuntimeError(audit)
                    tag=fingerprint({"problem":p,"solver":solver,"budget":budget,"seed":seed,"source":adapter_source(solver),"protocol":"fresh-process-resources-v1"})[:16]
                    path=ROOT/f"results/raw/scale-{solver}-{size}-{budget:g}s-{seed}-{tag}.json"
                    if path.exists():r=json.loads(path.read_text(encoding="utf-8"))
                    else:
                        r=measured_run(p,solver,budget,seed,path)
                        r.update(scope=str(size),experimentStage="SYNTHETIC_SCALING",sourceDatasetVersion=p["scalingSourceDatasetVersion"],scenarioFile=f"datasets/scaling-hd-v2/{size}.json")
                        save(path,r)
                    m=r.get("metrics") or {}
                    print(json.dumps({"solver":solver,"size":size,"budget":budget,"seed":seed,"status":r["status"],"served":m.get("served"),"workers":m.get("workersUsed"),"wallMs":r.get("resources",{}).get("processWallTimeMs")}),flush=True)


if __name__=="__main__":main()
