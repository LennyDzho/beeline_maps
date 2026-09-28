"""Recalculate published plan metrics from frozen inputs; no solver execution."""
import json
import hashlib
import math
import sys
from collections import Counter
from datetime import datetime,timezone
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
from core.metrics import calculate_metrics
from core.problem_model import fingerprint
from scripts.run_static_baseline import subset


def read(path):return json.loads(path.read_text(encoding="utf-8"))


def main():
    canonical=read(ROOT/"datasets/problem.json")
    bounds_path=ROOT/"results/structural_lower_bounds.json"
    structural=read(bounds_path) if bounds_path.exists() else {}
    if structural.get("problemFingerprint")!=fingerprint(canonical):structural={}
    rows=read(ROOT/"results/all_benchmark_results.json")
    inputs={};issues=[];statuses=Counter();checked=0;bounds=0
    freeze_path=ROOT/"results/frozen-evidence.json"
    frozen_count=0
    if freeze_path.exists():
        freeze=read(freeze_path)
        frozen_paths={str(Path(r["file"])) for r in freeze["runs"]}
        published_paths={str(Path(r["rawFile"])) for r in rows}
        if frozen_paths!=published_paths or len(rows)!=freeze["measurements"]:
            issues.append({"issue":"Published measurement set differs from user-requested frozen snapshot"})
        for entry in freeze["runs"]:
            if hashlib.sha256((ROOT/entry["file"]).read_bytes()).hexdigest()!=entry["sha256"]:
                issues.append({"rawFile":entry["file"],"issue":"Frozen raw SHA256 changed"})
            frozen_count+=1
    for row in rows:
        raw=read(ROOT/row["rawFile"]);statuses[raw["status"]]+=1
        input_key=(row["experiment"],row["scope"])
        if input_key not in inputs:
            inputs[input_key]=subset(canonical,row["scope"]) if row["experiment"]=="static" else read(ROOT/raw["scenarioFile"])
        p=inputs[input_key]
        def issue(message):issues.append({"rawFile":row["rawFile"],"issue":message})
        if raw["problemFingerprint"]!=fingerprint(p):issue("Frozen input fingerprint mismatch")
        if raw["preflight"]["status"]!="READY":issue("A published measurement lacks READY preflight")
        if raw["matrixVersion"]!=canonical["matrixVersion"]:issue("Mixed road matrix versions")
        original=raw.get("metrics") or {}
        if not original.get("eligibleForComparison"):continue
        if raw["status"] not in {"OPTIMAL","FEASIBLE"}:issue("Unexpected comparison-eligible status")
        solution=raw["solution"]
        recalculated=calculate_metrics(p,solution);checked+=1
        if not recalculated.get("eligibleForComparison"):
            issue("Independent revalidation found a hard violation");continue
        if structural and row["experiment"]=="static" and row["scope"]=="all" and recalculated["served"]==recalculated["jobsTotal"]:
            if recalculated["workersUsed"]<structural["staffLowerBoundForFullCoverage"]:issue("Feasible full plan contradicts structural crew lower bound")
        for key,value in recalculated.items():
            if key=="validationTimeMs" or isinstance(value,(dict,list)):continue
            old=original.get(key)
            same=math.isclose(value,old,rel_tol=1e-12,abs_tol=1e-8) if isinstance(value,(int,float)) and isinstance(old,(int,float)) else old==value
            if not same:issue(f"Metric differs: {key}, stored={old}, recalculated={value}")
        if raw["solver"] in {"cpsat","scip","cbc"} and row.get("policy")=="PRIMARY":
            weights=solution.get("rawDiagnostics",{}).get("weights")
            obj=solution.get("solverObjective");bound=solution.get("bestBound")
            if weights is not None and obj is not None:
                computed=recalculated["unassigned"]*weights[0]+recalculated["workersUsed"]*weights[1]+recalculated["distanceMetres"]
                if not math.isclose(computed,obj,rel_tol=0,abs_tol=.01):issue(f"Native scalar does not match externally counted plan: {obj} vs {computed}")
            if bound is not None and obj is not None:
                bounds+=1
                if bound>obj+.01:issue(f"Lower bound exceeds incumbent: {bound} > {obj}")
                if raw["status"]=="OPTIMAL" and not math.isclose(bound,obj,rel_tol=0,abs_tol=.01):issue("OPTIMAL bound differs from incumbent")
    result={"checkedAt":datetime.now(timezone.utc).isoformat(),"status":"PASS" if not issues else "FAIL",
        "measurements":len(rows),"frozenRawHashesChecked":frozen_count,"revalidatedPlans":checked,"checkedNativeBounds":bounds,"statuses":dict(statuses),"inputVariants":len(inputs),"issues":issues}
    (ROOT/"results/report_evidence_audit.json").write_text(json.dumps(result,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
    archive=ROOT/"results/audit-history";archive.mkdir(exist_ok=True)
    (archive/(datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S")+"-"+result["status"]+".json")).write_text(json.dumps(result,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
    print(json.dumps({k:v for k,v in result.items() if k!="issues"}))
    if issues:
        print(json.dumps(issues[:10],ensure_ascii=False));raise SystemExit(1)


if __name__=="__main__":main()
