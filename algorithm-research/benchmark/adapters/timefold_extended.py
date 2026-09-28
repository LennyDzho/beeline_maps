"""Separate local Timefold policy/protection model; baseline stays unchanged."""
import copy
import json
import os
import subprocess
import time
from pathlib import Path
from core.preflight import require_ready

ROOT=Path(__file__).resolve().parents[1]


def solve(problem,policy,time_limit,seed,initial_solution=None,fixed_activities=None):
    p=copy.deepcopy(problem)
    if initial_solution is not None: p["previousSolution"]=initial_solution
    if fixed_activities: p["fixedActivities"]=p.get("fixedActivities",[])+fixed_activities
    require_ready(p)
    began=time.perf_counter()
    info=json.loads((ROOT/"registry/java-runtime.json").read_text(encoding="utf-8"))
    scratch=ROOT/".cache/timefold-extended"/str(time.time_ns()); scratch.mkdir(parents=True)
    source,target=scratch/"input.json",scratch/"output.json"
    source.write_text(json.dumps(p,ensure_ascii=False),encoding="utf-8")
    cp=str(ROOT/"runtime/java-build/classes")+os.pathsep+(ROOT/"runtime/java-classpath.txt").read_text(encoding="utf-8").strip()
    argv=[str(ROOT/info["javaHome"]/"bin/java.exe"),"-Xmx2g","-Dorg.slf4j.simpleLogger.defaultLogLevel=warn","-cp",cp,
        "research.ExtendedBridge",str(source),str(target),str(time_limit),str(seed),policy]
    with (scratch/"native.log").open("w",encoding="utf-8") as log:
        native=subprocess.run(argv,stdin=subprocess.DEVNULL,stdout=log,stderr=subprocess.STDOUT,
            timeout=max(45,time_limit*4+15),creationflags=getattr(subprocess,"CREATE_NO_WINDOW",0))
    if native.returncode or not target.exists(): raise RuntimeError(f"Timefold extended exit {native.returncode}: {scratch/'native.log'}")
    result=json.loads(target.read_text(encoding="utf-8"))
    result.setdefault("runtime",{})["solverWallTimeMs"]=(time.perf_counter()-began)*1000
    return result
