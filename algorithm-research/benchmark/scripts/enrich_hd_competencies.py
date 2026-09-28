"""Promote the strict HD scenario; preserve the coarse-category v1 intact."""
import copy
import json
import sys
from collections import defaultdict, Counter
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
from core.competencies import normalize_hd, token, required_tokens, supported_tokens
from core.problem_model import fingerprint
from core.preflight import check_problem


def save(path,value):
    path.parent.mkdir(parents=True,exist_ok=True)
    path.write_text(json.dumps(value,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")


def main():
    source=json.loads((ROOT.parent/"datasets/beeline-v1/dataset.json").read_text(encoding="utf-8"))
    old_path=ROOT/"datasets/problem-coarse-v1.json"
    if not old_path.exists():old_path.write_bytes((ROOT/"datasets/problem.json").read_bytes())
    old=json.loads(old_path.read_text(encoding="utf-8")); p=copy.deepcopy(old)
    enriched=copy.deepcopy(source); workers={w["id"]:w for w in enriched["workers"]}
    evidence=defaultdict(lambda:defaultdict(list))
    for j in enriched["jobs"]:
        j.update(bkType=j["sourceBK"],requiredHdTypes=normalize_hd(j["sourceHD"]))
        wid=j["historicalAssignment"]["workerId"]
        if wid:
            for hd in j["requiredHdTypes"]:evidence[wid][(j["bkType"],hd)].append(j["id"])
    for wid,w in workers.items():
        w["supportedHdTypes"]={bk:sorted(hd for b,hd in evidence[wid] if b==bk) for bk in sorted({b for b,h in evidence[wid]})}
        w["hdCompetencyEvidence"]=[{"bkType":bk,"hdType":hd,"jobIds":ids} for (bk,hd),ids in sorted(evidence[wid].items())]
    jobs={j["id"]:j for j in enriched["jobs"]}
    for w in p["workers"]:
        w["supportedHdTypes"]=workers[w["id"]]["supportedHdTypes"]
        w["qualifications"]=sorted(supported_tokens(w))
    for j in p["jobs"]:
        j["bkType"]=jobs[j["id"]]["bkType"]
        j["requiredHdTypes"]=jobs[j["id"]]["requiredHdTypes"]
        j["requiredQualifications"]=sorted(required_tokens(j))
    enriched["schemaVersion"]=2
    enriched["metadata"]["competencyRule"]="Union of observed normalized HD types within exact BK, all retained historical assignment statuses; combined HD requires every type, one visit and unchanged source BK duration."
    p.update(id="beeline-car-no-breaks-v2-strict-hd",datasetVersion=fingerprint(enriched),competencyModel="bk-scoped-hd-v2",
        sourceDataset="../../datasets/beeline-hd-v2/dataset.json",supersedesDatasetVersion=old["datasetVersion"])
    p["competencyProvenance"]={"sourceRequirement":"ALGORITHM_RESEARCH_REQUIREMENTS.md D-033/H03", "normalization":{
        "Заказ подключения":"Заявка на подключение","Заказ подключения/Дозаказ оборудования":["Заявка на подключение","Дозаказ оборудования"]},
        "adapterEncoding":"Conjunctive qualification tokens; independent H03 verifies original BK/HD fields", "durationRule":"One original BK duration for one combined visit, unchanged across candidates; no extra duration invented"}
    no_workers=[]; coverage={}; removed=0
    for j in p["jobs"]:
        broad=[w for w in p["workers"] if w["divisionId"]==j["divisionId"] and j["requiredSkill"] in w["skills"]]
        strict=[w for w in broad if required_tokens(j)<=supported_tokens(w)]
        removed+=len(broad)-len(strict);coverage[j["id"]]=[w["id"] for w in strict]
        if not strict:no_workers.append(j["id"])
    for j in enriched["jobs"]:
        wid=j["historicalAssignment"]["workerId"]
        assert not wid or required_tokens(j)<=supported_tokens(workers[wid]),j["id"]
    audit=check_problem(p)
    if audit["status"]!="READY":raise RuntimeError(audit)
    report={"datasetVersion":p["datasetVersion"],"matrixVersion":p["matrixVersion"],"preflight":audit,
        "workers":len(workers),"jobs":len(p["jobs"]),"hdCompetencyLinks":sum(len(e) for e in evidence.values()),
        "combinedHdJobs":sum(len(j["requiredHdTypes"])>1 for j in p["jobs"]),"removedCoarseEligiblePairs":removed,
        "jobsWithoutEligibleWorker":no_workers,"eligibleWorkersByJob":coverage,
        "eligibleWorkerCountDistribution":dict(sorted(Counter(len(v) for v in coverage.values()).items()))}
    target=ROOT.parent/"datasets/beeline-hd-v2"
    save(target/"dataset.json",enriched);save(target/"validation.json",report)
    lines=["# Квалификации бригад по конкретным HD", "", "Только наблюдавшиеся работы в своём подразделении. Категории ВК не дают автоматического допуска ко всем HD. Исходные имена и ссылки на строки находятся в dataset.json.", "", "| Бригада | Подразделение | ВК | Допустимые HD |", "|---|---|---|---|"]
    for w in workers.values():
        for bk,types in w["supportedHdTypes"].items():lines.append(f"| {w['name']} | {w['divisionId']} | {bk} | {'; '.join(types)} |")
    (target/"WORKERS.md").write_text("\n".join(lines)+"\n",encoding="utf-8")
    save(ROOT/"datasets/problem.json",p)
    print(json.dumps({k:v for k,v in report.items() if k!="eligibleWorkersByJob"},ensure_ascii=False))


if __name__=="__main__":
    sys.stdout.reconfigure(encoding="utf-8");main()
