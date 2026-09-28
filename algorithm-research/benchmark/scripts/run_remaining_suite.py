"""Resumable, serial remaining experiment stages; no scheduled/background daemon.

Each child script saves individual runs. This driver saves stage boundaries.
To request a safe stop, create results/STOP_REQUESTED; the next stage is not
started. For a running campaign, interruption still preserves completed runs.
"""
import argparse
import hashlib
import json
import subprocess
import sys
from datetime import datetime,timezone
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
from core.preflight import require_ready
from core.problem_model import fingerprint
from scripts.run_campaign import save

ALL=["ortools_routing","vroom","jsprit","pyvrp","timefold","cpsat","choco","alns","scip","cbc"]
HEURISTIC=["ortools_routing","vroom","jsprit","pyvrp","timefold","alns"]
EXACT=["cpsat","scip","cbc","choco"]
SEEDS=[str(i) for i in range(2,11)]


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--phase",choices=["broad","repeats","all"],default="all")
    args=parser.parse_args()
    p=json.loads((ROOT/"datasets/problem.json").read_text(encoding="utf-8"));require_ready(p)
    stages=[]
    if args.phase in {"broad","all"}:
        stages += [
            ("quality-regression-more-time","run_regression_matrix.py",["--solvers","cbc","scip","choco","--tests","T07","T08","--budget","15"]),
            ("exact-all-methods","run_campaign.py",["--solvers",*ALL,"--budgets","15","--scopes","exact-5","exact-10","exact-15","exact-20"]),
            ("exact-proof-20","run_campaign.py",["--solvers",*EXACT,"--budgets","60","--scopes","exact-20"]),
            ("scale-controls","run_scaling_cases.py",["--solvers",*ALL,"--budgets","15"]),
            ("report-after-broad","preflight_report.py",[])]
    if args.phase in {"repeats","all"}:
        stages += [
            ("primary-repeats","run_campaign.py",["--solvers",*HEURISTIC,"--budgets","1","5","15","60","300","--seeds",*SEEDS,"--scopes","all"]),
            ("report-after-primary","preflight_report.py",[]),
            ("dynamic-repeats","run_policy_cases.py",["--solvers","ortools_routing","alns","timefold","--budget","5","--seeds",*SEEDS]),
            ("scale-repeat-controls","run_scaling_cases.py",["--solvers",*HEURISTIC,"--budgets","15","--seeds",*SEEDS]),
            ("final-evidence-report","preflight_report.py",[]),
            ("source-checkpoint","snapshot_research_code.py",[])]
    path=ROOT/"results/remaining-suite-state.json"
    state=json.loads(path.read_text(encoding="utf-8")) if path.exists() else {"problemFingerprint":fingerprint(p),"stages":{}}
    if state["problemFingerprint"]!=fingerprint(p):raise RuntimeError("Saved suite belongs to another dataset; preserve it before starting a new suite")
    state.update(status="RUNNING",updatedAt=datetime.now(timezone.utc).isoformat());save(path,state)
    for name,script,arguments in stages:
        if (ROOT/"results/STOP_REQUESTED").exists():
            state.update(status="STOPPED_AT_STAGE_BOUNDARY",updatedAt=datetime.now(timezone.utc).isoformat());save(path,state);return
        previous=state["stages"].get(name,{})
        if previous.get("status")=="COMPLETE":continue
        stage={"status":"RUNNING","script":script,"arguments":arguments,"startedAt":datetime.now(timezone.utc).isoformat()}
        state["stages"][name]=stage;save(path,state)
        print(json.dumps({"stage":name,"status":"STARTING"}),flush=True)
        code=subprocess.call([sys.executable,"-u",str(ROOT/"scripts"/script),*arguments],stdin=subprocess.DEVNULL)
        stage.update(status="COMPLETE" if code==0 else "ERROR",exitCode=code,finishedAt=datetime.now(timezone.utc).isoformat())
        state["updatedAt"]=datetime.now(timezone.utc).isoformat();save(path,state)
        if code:
            state["status"]="STOPPED_AFTER_ERROR";save(path,state);raise SystemExit(code)
    state.update(status="COMPLETE_FOR_SELECTED_PHASE",updatedAt=datetime.now(timezone.utc).isoformat());save(path,state)


if __name__=="__main__":main()
