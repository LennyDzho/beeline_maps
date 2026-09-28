"""Snapshot only research source/locks; never application files or credentials."""
import hashlib
import json
import zipfile
from datetime import datetime,timezone
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]


def main():
    files=[]
    for folder in ["adapters","core","scripts","tests","requirements"]:
        for p in (ROOT/folder).rglob("*"):
            if p.is_file() and p.suffix in {".py",".java",".xml",".md",".json",".txt",".toml"}:
                files.append(p)
    for name in ["runner.py","README.md","registry/environment.json","registry/java-build.json","registry/java-runtime.json","registry/cbc-runtime.json","registry/verified-registry.json","registry/license-evidence.json"]:
        p=ROOT/name
        if p.exists():files.append(p)
    files.extend(p for p in (ROOT/"registry/licenses").rglob("*") if p.is_file())
    stamp=datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    target=ROOT/"registry"/f"research-code-{stamp}.zip"
    hashes={str(p.relative_to(ROOT)).replace("\\","/"):hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(files)}
    with zipfile.ZipFile(target,"w",compression=zipfile.ZIP_DEFLATED) as archive:
        for p in sorted(files):archive.write(p,str(p.relative_to(ROOT)))
        archive.writestr("SOURCE_MANIFEST.json",json.dumps(hashes,ensure_ascii=False,indent=2))
    print(json.dumps({"archive":str(target),"files":len(files),"sha256":hashlib.sha256(target.read_bytes()).hexdigest()}))


if __name__=="__main__":main()
