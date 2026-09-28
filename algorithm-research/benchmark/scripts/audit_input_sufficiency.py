"""Read-only logical input audit plus a saved reviewable sufficiency report."""
import json
import sys
from pathlib import Path
from datetime import datetime,timezone
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
from core.preflight import check_problem
from core.problem_model import fingerprint
from adapters.linear_reference import eligible
from scripts.run_campaign import save


def main():
    paths=[ROOT/"datasets/problem.json"]+sorted((ROOT/"datasets/dynamic-hd-v2").glob("*.json"))+sorted((ROOT/"datasets/scaling-hd-v2").glob("*.json"))
    records=[]
    for path in paths:
        p=json.loads(path.read_text(encoding="utf-8"))
        if "workers" not in p or "jobs" not in p:continue
        audit=check_problem(p);impossible=[]
        for j in p["jobs"]:
            qualified=[w for w in p["workers"] if eligible(j,w)]
            possible=[w for w in qualified if max(w["availableAt"],w["shiftStart"],j["windowStart"],j["releaseTime"],p.get("eventAt") or 0)<=j["windowEnd"] and max(w["availableAt"],w["shiftStart"],j["windowStart"],j["releaseTime"],p.get("eventAt") or 0)+j["serviceDuration"]<=w["shiftEnd"]]
            if not possible:impossible.append({"jobId":j["id"],"qualifiedWorkerIds":[w["id"] for w in qualified],"proof":"Even with zero travel no qualified worker can start within window/release/availability and finish service inside shift"})
        records.append({"file":str(path.relative_to(ROOT)),"problemFingerprint":fingerprint(p),"preflight":audit,
            "jobsImpossibleEvenWithZeroTravel":impossible,"optimisticCoverageUpperBound":len(p["jobs"])-len(impossible)})
    save(ROOT/"results/input_sufficiency.json",{"checkedAt":datetime.now(timezone.utc).isoformat(),"scope":"Presence, consistency and adapter encoding; not confirmation of synthetic assumptions or uncertain real addresses",
        "declaredAssumptions":["09:00–22:00 synthetic shift","All initial jobs known 09:00","Static car road snapshot, no traffic","Seven ambiguous building addresses resolved by declared model choices","HD competencies inferred from historic assignments, including cancelled rows; no evidence of universal competency outside observed types"],"records":records})
    print(json.dumps({"scenarios":len(records),"ready":sum(r["preflight"]["status"]=="READY" for r in records),"structurallyImpossible":{r["file"]:len(r["jobsImpossibleEvenWithZeroTravel"]) for r in records if r["jobsImpossibleEvenWithZeroTravel"]}}))


if __name__=="__main__":main()
