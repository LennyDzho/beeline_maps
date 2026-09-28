"""Local JVM subprocess interface; all scratch files remain in the research tree."""
import json
import os
import subprocess
import time
from pathlib import Path
from core.preflight import require_ready

ROOT = Path(__file__).resolve().parents[1]


def solve(problem, policy, time_limit, seed, initial_solution=None, fixed_activities=None, *, engine):
    require_ready(problem)
    if policy != "PRIMARY" or problem.get("eventAt") is not None or problem.get("fixedActivities") or problem.get("protectedActivities") or fixed_activities or initial_solution:
        raise NotImplementedError("Java adapters currently implement static PRIMARY")
    began=time.perf_counter()
    runtime=json.loads((ROOT / "registry/java-runtime.json").read_text(encoding="utf-8"))
    scratch=ROOT / ".cache" / engine / str(time.time_ns())
    scratch.mkdir(parents=True)
    source,target=scratch/"input.json",scratch/"output.json"
    source.write_text(json.dumps(problem,ensure_ascii=False),encoding="utf-8")
    classpath=str(ROOT/"runtime/java-build/classes")+os.pathsep+(ROOT/"runtime/java-classpath.txt").read_text(encoding="utf-8").strip()
    argv=[str(ROOT/runtime["javaHome"]/"bin/java.exe"),"-Xmx2g","-Dorg.slf4j.simpleLogger.defaultLogLevel=warn","-cp",classpath,
        "research.Bridge",engine,str(source),str(target),str(time_limit),str(seed)]
    with (scratch/"native.log").open("w",encoding="utf-8") as log:
        process=subprocess.run(argv,stdin=subprocess.DEVNULL,stdout=log,stderr=subprocess.STDOUT,
            timeout=max(45,4*time_limit+15),creationflags=getattr(subprocess,"CREATE_NO_WINDOW",0))
    if process.returncode or not target.exists():
        raise RuntimeError(f"{engine} exit {process.returncode}; native log: {scratch/'native.log'}")
    result=json.loads(target.read_text(encoding="utf-8"))
    result.setdefault("runtime",{})["solverWallTimeMs"]=(time.perf_counter()-began)*1000
    result.setdefault("rawDiagnostics",{})["jvmProtocol"]="Fresh JVM per run; startup, model construction and search included in wall time"
    return result
