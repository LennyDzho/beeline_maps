"""Build Java adapters with portable tools and a research-local Maven repository."""
import json
import hashlib
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
info = json.loads((ROOT / "registry/java-runtime.json").read_text(encoding="utf-8"))
java = ROOT / info["javaHome"]
maven = ROOT / info["mavenHome"]
environment = dict(os.environ, JAVA_HOME=str(java))
environment["PATH"] = str(java / "bin") + os.pathsep + environment["PATH"]
goals = sys.argv[1:] or ["compile", "dependency:build-classpath", "-Dmdep.regenerateFile=true", "-Dmdep.outputFile="+str(ROOT / "runtime/java-classpath.txt")]
# Maven's .cmd launcher is used only for this fixed build invocation, never
# for filesystem operations or dynamically built shell commands.
command = [str(maven / "bin/mvn.cmd"), "-B", "-ntp", "-f", str(ROOT / "adapters/java/pom.xml"),
    "-Dmaven.repo.local="+str(ROOT / ".cache/maven"), *goals]
code = subprocess.call(command, env=environment)
if code == 0:
    files = sorted((ROOT / "adapters/java/src").rglob("*.java")) + [ROOT / "adapters/java/pom.xml"]
    manifest = {"sources": {str(p.relative_to(ROOT)): hashlib.sha256(p.read_bytes()).hexdigest() for p in files}}
    classpath = ROOT / "runtime/java-classpath.txt"
    if classpath.exists():
        jars = [Path(p) for p in classpath.read_text(encoding="utf-8").strip().split(os.pathsep)]
        manifest["jars"] = {str(p.relative_to(ROOT)): hashlib.sha256(p.read_bytes()).hexdigest() for p in jars}
    (ROOT / "registry/java-build.json").write_text(json.dumps(manifest,indent=2)+"\n",encoding="utf-8")
raise SystemExit(code)
