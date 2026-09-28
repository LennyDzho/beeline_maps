"""Resumable serial runs in fresh processes, with sampled process-tree resources.

Never runs solvers concurrently. Every invocation rechecks canonical input data.
Results commit after each run; interruption loses at most the current run.
"""
import argparse
import json
import os
import random
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
import psutil

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
from core.problem_model import fingerprint
from core.preflight import check_problem
from runner import adapter_source
from scripts.run_static_baseline import subset


def save(path,value):
    temporary=path.with_suffix(".tmp")
    temporary.write_text(json.dumps(value,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
    temporary.replace(path)


def measured_run(p,solver,budget,seed,output,policy="PRIMARY"):
    scratch=ROOT/".cache/campaign"/str(time.time_ns())
    scratch.mkdir(parents=True)
    source=scratch/"problem.json"
    save(source,p)
    started=time.perf_counter()
    cpu_by_pid={}; peak=0; count=0; termination_reason=None
    with (scratch/"worker.log").open("w",encoding="utf-8") as log:
        child=subprocess.Popen([sys.executable,str(ROOT/"runner.py"),"--problem",str(source),"--solver",solver,
            "--time-limit",str(budget),"--seed",str(seed),"--policy",policy,"--output",str(output)],
            stdout=log,stderr=subprocess.STDOUT,stdin=subprocess.DEVNULL,creationflags=getattr(subprocess,"CREATE_NO_WINDOW",0))
        root=psutil.Process(child.pid)
        while child.poll() is None:
            try:
                family=[root]+root.children(recursive=True)
            except psutil.Error:
                family=[]
            rss=0
            for proc in family:
                try:
                    rss+=proc.memory_info().rss
                    cpu=proc.cpu_times()
                    cpu_by_pid[proc.pid]=max(cpu_by_pid.get(proc.pid,0),cpu.user+cpu.system)
                except psutil.Error:
                    pass
            peak=max(peak,rss); count+=1
            # Shared operational guard, not an additional business constraint.
            # Leave memory available for Windows and the user's desktop.
            if rss>6*1024**3:
                termination_reason="PROCESS_TREE_RSS_EXCEEDED_6_GIB"
            elif time.perf_counter()-started>max(90,budget*4+45):
                termination_reason="PROCESS_WALL_WATCHDOG"
            if termination_reason:
                for proc in reversed(family):
                    try: proc.kill()
                    except psutil.Error: pass
                child.wait(timeout=10)
                break
            time.sleep(.05)
    resource={"processWallTimeMs":(time.perf_counter()-started)*1000,"peakMemoryMb":peak/1024**2,
        "cpuTimeSampledMs":sum(cpu_by_pid.values())*1000,"sampleCount":count,"samplingIntervalMs":50,
        "memoryGuardMiB":6144,"terminationReason":termination_reason,
        "scope":"Fresh Python worker and descendants, including JVM/CBC. RSS peak is sampled, not an exact OS high-water mark; child CPU may be underestimated between samples."}
    if not output.exists():
        record={"solver":solver,"dataset":p["id"],"policy":policy,"timeLimitSec":budget,"seed":seed,
            "timestamp":datetime.now(timezone.utc).isoformat(),"datasetVersion":p["datasetVersion"],"matrixVersion":p["matrixVersion"],
            "problemFingerprint":fingerprint(p),"adapterVersion":fingerprint(adapter_source(solver)),"preflight":check_problem(p),
            "status":"RESOURCE_LIMIT" if termination_reason else "PROCESS_ERROR","solution":None,"metrics":None,"exitCode":child.returncode,"logFile":str(scratch/"worker.log")}
    else:
        record=json.loads(output.read_text(encoding="utf-8"))
    record["resources"]=resource
    return record


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--solvers",nargs="+",required=True)
    parser.add_argument("--budgets",type=float,nargs="+",default=[1,5,15,60,300])
    parser.add_argument("--seeds",type=int,nargs="+",default=[1])
    parser.add_argument("--scopes",nargs="+",default=["all"])
    args=parser.parse_args()
    original=json.loads((ROOT/"datasets/problem.json").read_text(encoding="utf-8"))
    audit=check_problem(original)
    if audit["status"]!="READY": raise RuntimeError(audit)
    planned=[]
    ordering=random.Random(20260918)
    for scope in args.scopes:
        for budget in args.budgets:
            for seed in args.seeds:
                methods=list(args.solvers);ordering.shuffle(methods)
                planned.extend((s,scope,budget,seed) for s in methods)
    campaign_id=datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S")
    state={"id":campaign_id,"status":"RUNNING","createdAt":datetime.now(timezone.utc).isoformat(),"configuration":vars(args),
        "total":len(planned),"completed":0,"matrixVersion":original["matrixVersion"],"runs":[],
        "executionOrderRule":"Budgets ascending as requested; methods shuffled per seed with fixed ordering seed 20260918; serial execution"}
    state_path=ROOT/"results"/f"campaign-{campaign_id}.json"
    save(state_path,state)
    for solver,scope,budget,seed in planned:
        p=subset(original,scope)
        tag=fingerprint({"problem":p,"solver":solver,"budget":budget,"seed":seed,"adapter":adapter_source(solver),"protocol":"fresh-process-resources-v1"})[:16]
        path=ROOT/f"results/raw/baseline-{solver}-{scope}-{budget:g}s-{seed}-{tag}.json"
        if path.exists():
            record=json.loads(path.read_text(encoding="utf-8"))
        else:
            record=measured_run(p,solver,budget,seed,path)
            record.update(scope=scope,experimentStage="STATIC_PRIMARY_FRESH_PROCESS",campaignId=campaign_id)
            save(path,record)
        state["completed"]+=1
        state["runs"].append({"path":str(path.relative_to(ROOT)),"status":record["status"]})
        state["updatedAt"]=datetime.now(timezone.utc).isoformat()
        save(state_path,state)
        metrics=record.get("metrics") or {}
        print(json.dumps({"solver":solver,"scope":scope,"budget":budget,"seed":seed,"status":record["status"],
            "served":metrics.get("served"),"workers":metrics.get("workersUsed"),"distanceKm":metrics.get("distanceKm"),
            "progress":f"{state['completed']}/{state['total']}"}),flush=True)
    state["status"]="COMPLETE"
    save(state_path,state)


if __name__=="__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main()
