"""Freeze one common prior plan and create five explicitly synthetic events."""
import copy
import json
import sys
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
from core.preflight import check_problem
from core.problem_model import fingerprint
from core.replanning import freeze_at
from core.validator import validate
from adapters.linear_reference import eligible


def save(path,data):
    path.write_text(json.dumps(data,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")


def main():
    p=json.loads((ROOT/"datasets/problem.json").read_text(encoding="utf-8"))
    root=ROOT/"datasets"/("dynamic-hd-v2" if p.get("competencyModel") else "dynamic-v1"); root.mkdir(exist_ok=True)
    reference=root/"initial-plan.json"
    if reference.exists():
        record=json.loads(reference.read_text(encoding="utf-8"))
    else:
        candidates=[]
        for path in (ROOT/"results/raw").glob("baseline-ortools_routing-all-5s-1-*.json"):
            r=json.loads(path.read_text(encoding="utf-8"))
            if r["datasetVersion"]==p["datasetVersion"] and (r.get("metrics") or {}).get("eligibleForComparison"):
                candidates.append((r["timestamp"],path,r))
        _,path,r=max(candidates,key=lambda item:item[0])
        record={"sourceRawFile":str(path.relative_to(ROOT)),"selectionRule":"Latest valid OR-Tools Routing PRIMARY 5s seed1 plan for the same dataset at scenario creation; fixed state donor, not a winner selection",
            "problemFingerprint":fingerprint(p),"solution":r["solution"]}
        save(reference,record)
    if record["problemFingerprint"]!=fingerprint(p): raise RuntimeError("Frozen initial plan belongs to a different problem")
    if validate(p,record["solution"])["totalHardViolations"]: raise RuntimeError("Invalid reference plan")
    base=freeze_at(p,record["solution"],11*3600)
    jobs={j["id"]:j for j in base["jobs"]}
    assignments={v["jobId"]:{**v,"workerId":r["workerId"]} for r in record["solution"]["routes"] for v in r["visits"] if v["jobId"] in jobs}
    # One future customer-confirmed visit per division, retained in all events.
    for division in sorted({w["divisionId"] for w in base["workers"]}):
        future=[a for jid,a in assignments.items() if jobs[jid]["divisionId"]==division and a["start"]>=13*3600]
        if future:
            a=min(future,key=lambda a:(a["start"],a["jobId"]))
            base["protectedActivities"].append({**a,"protection":"customer_confirmed"})
    protected={a["jobId"] for a in base["protectedActivities"]}
    free=[jobs[jid] for jid in sorted(assignments,key=lambda jid:(assignments[jid]["start"],jid)) if jid not in protected]
    cases={}
    urgent=copy.deepcopy(base)
    j=copy.deepcopy(next(j for j in p["jobs"] if j["isEmergency"] and j["divisionId"]=="east"))
    j.update(id="synthetic-event-emergency",releaseTime=11*3600,windowStart=0,windowEnd=86399,isEmergency=True,
        synthetic=True,syntheticSourceJobId=j["id"])
    urgent["jobs"].append(j)
    urgent["event"]={"type":"new_emergency","jobId":j["id"],"description":"Новая авария в 11:00 по уже известной точке дорожной матрицы"}
    cases["new_emergency"]=urgent

    cancelled=copy.deepcopy(base); jid=free[0]["id"]
    cancelled["jobs"]=[j for j in cancelled["jobs"] if j["id"]!=jid]
    cancelled["event"]={"type":"cancellation","jobId":jid,"description":"Отмена ещё не начатой незапрещённой к изменению заявки"}
    cases["cancellation"]=cancelled

    unavailable=copy.deepcopy(base)
    protected_workers={a["workerId"] for a in base["protectedActivities"]}
    candidates=[w for w in unavailable["workers"] if w["id"] not in protected_workers and any(a["workerId"]==w["id"] for a in assignments.values())]
    w=max(candidates,key=lambda w:sum(a["workerId"]==w["id"] for a in assignments.values()))
    effective=w["availableAt"]; w["availableAt"]=w["shiftEnd"]
    unavailable["event"]={"type":"worker_unavailability","workerId":w["id"],"effectiveAfterCommittedAt":effective,
        "description":"Исполнитель завершает защищённую начатую часть, после неё недоступен до конца смены"}
    cases["worker_unavailability"]=unavailable

    manual=copy.deepcopy(base); chosen=None
    for job in free:
        old=assignments[job["id"]]
        for worker in manual["workers"]:
            if worker["id"]==old["workerId"] or worker["id"] in protected_workers or not eligible(job,worker): continue
            travel=manual["travelTimeMatrices"][worker["transportMode"]][worker["startLocationId"]][job["locationId"]]
            if travel is None: continue
            start=max(worker["availableAt"]+travel,job["windowStart"],job["releaseTime"])
            if start<=job["windowEnd"] and start+job["serviceDuration"]<=worker["shiftEnd"]:
                chosen={"jobId":job["id"],"workerId":worker["id"],"start":start,"finish":start+job["serviceDuration"]}; break
        if chosen: break
    if chosen is None: raise RuntimeError("No explicit feasible manual reassignment scenario")
    manual["fixedActivities"].append(chosen)
    manual["event"]={"type":"manual_assignment","before":assignments[chosen["jobId"]],"after":chosen,"description":"Ручное переназначение фиксируется, остальные свободные визиты можно пересчитать"}
    cases["manual_assignment"]=manual

    timed=copy.deepcopy(base)
    job=next(j for j in free if assignments[j["id"]]["start"]+300<=j["windowEnd"] and assignments[j["id"]]["finish"]+300<=next(w["shiftEnd"] for w in base["workers"] if w["id"]==assignments[j["id"]]["workerId"]))
    old=assignments[job["id"]]; new={**old,"start":old["start"]+300,"finish":old["finish"]+300}
    timed["fixedActivities"].append(new)
    timed["event"]={"type":"manual_time","before":old,"after":new,"description":"Ручной сдвиг ещё не начатого визита на пять минут, внутри его окна и смены"}
    cases["manual_time"]=timed
    summary=[]
    for name,case in cases.items():
        case["id"]=p["id"]+"::"+root.name+"::"+name
        case["syntheticScenario"]=True
        case["scenarioProvenance"]={"referenceFile":"initial-plan.json","commonSnapshot":fingerprint(base),"event":case["event"]}
        audit=check_problem(case)
        if audit["status"]!="READY": raise RuntimeError(audit)
        save(root/(name+".json"),case)
        summary.append({"scenario":name,"jobsRemaining":len(case["jobs"]),"committedActivities":len(case["pastActivities"]),
            "protectedVisits":len(case["protectedActivities"]),"fixedVisits":len(case["fixedActivities"]),"problemFingerprint":fingerprint(case),"preflight":audit})
    save(root/"manifest.json",{"matrixVersion":p["matrixVersion"],"eventAt":11*3600,"scenarios":summary,
        "note":"Synthetic events on one immutable prior plan. All solvers must receive identical per-event inputs, including current locations and next availability."})
    print(json.dumps(summary,ensure_ascii=False))


if __name__=="__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main()
