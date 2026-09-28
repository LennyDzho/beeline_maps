"""Record local runtime versions and checksums without credentials or user files."""
import hashlib
import importlib.metadata
import json
import platform
import sys
from datetime import datetime, timezone
from pathlib import Path
import psutil

ROOT=Path(__file__).resolve().parents[1]
packages={p.metadata["Name"]:p.version for p in importlib.metadata.distributions()}
(ROOT/"requirements/python-lock.txt").write_text("\n".join(f"{k}=={v}" for k,v in sorted(packages.items(),key=lambda x:x[0].lower()))+"\n",encoding="utf-8")
problem=json.loads((ROOT/"datasets/problem.json").read_text(encoding="utf-8"))
data={"recordedAt":datetime.now(timezone.utc).isoformat(),"platform":platform.platform(),"processor":platform.processor(),
    "python":sys.version,"logicalCpuCount":psutil.cpu_count(),"physicalCpuCount":psutil.cpu_count(logical=False),
    "totalMemoryBytes":psutil.virtual_memory().total,"packages":packages,"matrixVersion":problem["matrixVersion"],
    "protocol":{"optimizationParallelism":"One solver run at a time; native search configured for one thread where supported",
        "javaHeapLimit":"2 GiB","javaStartup":"New JVM per run; included in solver wall time",
        "budget":"Native search budget, except ALNS construction included. CBC uses CPU limit. Complete wall time separately reported.",
        "resources":"Fresh Python process and child-process RSS/CPU sampled every 50 ms in run_campaign.py",
        "hardwareIsolation":"User desktop; no claim of dedicated hardware, fixed CPU frequency or absence of other applications"},
    "criticalFiles":{}}
for name in ["datasets/problem.json","datasets/configuration.snapshot.json","requirements/python-lock.txt","registry/java-runtime.json","registry/java-build.json","registry/cbc-runtime.json"]:
    path=ROOT/name
    if path.exists(): data["criticalFiles"][name]={"sha256":hashlib.sha256(path.read_bytes()).hexdigest(),"bytes":path.stat().st_size}
(ROOT/"registry/environment.json").write_text(json.dumps(data,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
print(json.dumps({"packages":len(packages),"logicalCpus":data["logicalCpuCount"],"physicalCpus":data["physicalCpuCount"],"memoryGiB":data["totalMemoryBytes"]/1024**3}))
