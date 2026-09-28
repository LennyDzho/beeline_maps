"""Preserve installed package notices/POMs locally; no inference of legal duties."""
import hashlib
import importlib.metadata
import json
import re
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from xml.etree import ElementTree

ROOT=Path(__file__).resolve().parents[1]
OUTPUT=ROOT/"registry/licenses/installed"


def keep(data,name,source):
    digest=hashlib.sha256(data).hexdigest()
    name=re.sub(r"[^a-zA-Z0-9_.-]","-",name)
    target=OUTPUT/f"{digest[:10]}-{name}"
    target.write_bytes(data)
    return {"file":target.relative_to(ROOT).as_posix(),"sha256":digest,"source":source}


def main():
    OUTPUT.mkdir(parents=True,exist_ok=True)
    evidence=[]
    for package in ["ortools","pyvroom","pyvrp","alns","pyscipopt","pulp"]:
        dist=importlib.metadata.distribution(package)
        row={"component":package,"version":dist.version,"kind":"python-distribution",
             "licenseExpression":dist.metadata.get("License-Expression"),
             "licenseField":dist.metadata.get("License"),"files":[]}
        for item in dist.files or []:
            if ".dist-info/" not in str(item):continue
            if item.name!="METADATA" and not any(term in item.name.lower() for term in ["license","copying","notice"]):continue
            row["files"].append(keep(Path(dist.locate_file(item)).read_bytes(),f"{package}-{dist.version}-{item.name}",str(item)))
        if package=="pyscipopt":row["scopeNote"]="This MIT notice is for the binding; SCIP engine Apache-2.0 is recorded separately in verified-registry.json."
        if package=="pulp":row["scopeNote"]="PuLP binding MIT is separate from the official CBC executable EPL-2.0."
        if package=="pyvroom":row["scopeNote"]="Distribution version does not prove the embedded VROOM core commit."
        evidence.append(row)
    build=json.loads((ROOT/"registry/java-build.json").read_text(encoding="utf-8"))
    ns={"m":"http://maven.apache.org/POM/4.0.0"}
    for relative,digest in build["jars"].items():
        jar=ROOT/relative
        if not any(jar.name.startswith(name+"-") for name in ["jsprit-core","timefold-solver-core","choco-solver"]):continue
        row={"component":jar.stem,"kind":"java-artifact","jarSha256":digest,"files":[],"pomLicenses":[]}
        with zipfile.ZipFile(jar) as archive:
            for name in archive.namelist():
                if not name.endswith("/") and any(term in name.rsplit("/",1)[-1].lower() for term in ["license","notice"]):
                    row["files"].append(keep(archive.read(name),jar.stem+"-"+name.rsplit("/",1)[-1],relative+"!"+name))
        pom=jar.with_suffix(".pom")
        visited=set()
        while pom.exists() and pom not in visited:
            visited.add(pom)
            row["files"].append(keep(pom.read_bytes(),pom.name,pom.relative_to(ROOT).as_posix()))
            xml=ElementTree.fromstring(pom.read_bytes())
            for license_node in xml.findall("m:licenses/m:license",ns):
                row["pomLicenses"].append({"name":license_node.findtext("m:name",namespaces=ns),"url":license_node.findtext("m:url",namespaces=ns)})
            parent=xml.find("m:parent",ns)
            if parent is None:break
            group=parent.findtext("m:groupId",namespaces=ns);artifact=parent.findtext("m:artifactId",namespaces=ns);version=parent.findtext("m:version",namespaces=ns)
            if not all([group,artifact,version]) or "${" in version:break
            pom=ROOT/".cache/maven"/group.replace(".","/")/artifact/version/f"{artifact}-{version}.pom"
        evidence.append(row)
    cbc=ROOT/"runtime/cbc-2.10.13/LICENSE"
    evidence.append({"component":"CBC","version":"2.10.13","kind":"native-executable", "files":[keep(cbc.read_bytes(),"cbc-2.10.13-LICENSE",cbc.relative_to(ROOT).as_posix())]})
    manifest={"checkedAt":datetime.now(timezone.utc).isoformat(),"scope":"Installed direct optimizer components and bindings, not a full transitive dependency legal audit.","components":evidence}
    (ROOT/"registry/license-evidence.json").write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
    print(json.dumps({"components":len(evidence),"files":sum(len(r["files"]) for r in evidence)}))


if __name__=="__main__":main()
