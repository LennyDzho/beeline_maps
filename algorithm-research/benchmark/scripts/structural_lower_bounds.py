"""Prove a necessary staff bound by enumerating small division crew subsets.

This relaxation ignores travel, waiting and simultaneous job scheduling. It
cannot certify that a subset admits a route or that an incumbent is optimal.
No optimizer or random sampling is used.
"""
import json
import sys
from datetime import datetime,timezone
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
from core.preflight import require_ready
from core.problem_model import fingerprint


def compatible(job,worker):
    return (job["divisionId"]==worker["divisionId"]
        and job["requiredSkill"] in worker["skills"]
        and job.get("requiredTransportMode") in (None,worker["transportMode"])
        and set(job.get("requiredQualifications",[]))<=set(worker.get("qualifications",[]))
        and set(job.get("requiredEquipment",[]))<=set(worker.get("equipment",[]))
        and set(job.get("requiredHdTypes",[]))<=set(worker.get("supportedHdTypes",{}).get(job.get("bkType"),[]))
        and max(job["releaseTime"],job["windowStart"],worker["availableAt"],worker["shiftStart"])<=min(job["windowEnd"],worker["shiftEnd"]-job["serviceDuration"]))


def calculate(problem):
    rows=[]
    for division in sorted({j["divisionId"] for j in problem["jobs"]}):
        jobs=[j for j in problem["jobs"] if j["divisionId"]==division]
        workers=[w for w in problem["workers"] if w["divisionId"]==division]
        if len(workers)>20:raise ValueError("Enumeration is restricted to the original small divisions")
        masks=[sum(1<<i for i,w in enumerate(workers) if compatible(j,w)) for j in jobs]
        if any(mask==0 for mask in masks):raise ValueError("Full coverage impossible even without travel")
        service=sum(j["serviceDuration"] for j in jobs)
        capacities=[min(max(0,w["shiftEnd"]-max(w["shiftStart"],w["availableAt"])),
            sum(j["serviceDuration"] for j,mask in zip(jobs,masks) if mask&(1<<i))) for i,w in enumerate(workers)]
        qualification_min=len(workers)+1;combined_min=len(workers)+1;subsets=0
        for chosen in range(1,1<<len(workers)):
            subsets+=1;count=chosen.bit_count()
            if count>=combined_min and count>=qualification_min:continue
            if not all(chosen&mask for mask in masks):continue
            qualification_min=min(qualification_min,count)
            capacity=sum(c for i,c in enumerate(capacities) if chosen&(1<<i))
            if capacity>=service:combined_min=min(combined_min,count)
        if combined_min>len(workers):raise ValueError("Insufficient aggregate service capacity")
        rows.append({"divisionId":division,"jobs":len(jobs),"workersAvailable":len(workers),
            "serviceHours":service/3600,"qualificationCoverageLowerBound":qualification_min,
            "qualificationAndServiceLowerBound":combined_min,"enumeratedSubsets":subsets,
            "forcedWorkers":sorted({workers[mask.bit_length()-1]["id"] for mask in masks if mask.bit_count()==1})})
    return {"problemFingerprint":fingerprint(problem),"datasetVersion":problem["datasetVersion"],
        "matrixVersion":problem["matrixVersion"],"divisions":rows,
        "staffLowerBoundForFullCoverage":sum(r["qualificationAndServiceLowerBound"] for r in rows),
        "proof":"Every full-coverage plan must choose a subset covering every job's exact eligibility and sufficient total service capacity. Enumerating all crew subsets proves the minimum cardinality satisfying these necessary conditions. Divisions cannot share crews, so bounds add.",
        "limitations":"Travel, waiting and joint time-window scheduling are relaxed; this is a staff lower bound, not a feasible plan or proof of route optimality."}


def main():
    problem=json.loads((ROOT/"datasets/problem.json").read_text(encoding="utf-8"));require_ready(problem)
    result=calculate(problem);result["checkedAt"]=datetime.now(timezone.utc).isoformat()
    (ROOT/"results/structural_lower_bounds.json").write_text(json.dumps(result,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
    print(json.dumps({"staffLowerBound":result["staffLowerBoundForFullCoverage"],"divisions":len(result["divisions"])}))


if __name__=="__main__":main()
