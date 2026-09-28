"""Explicit resampled demand at the frozen road nodes; no invented road arcs."""
import copy
import json
import math
import random
import sys
from collections import Counter
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
from core.problem_model import fingerprint
from core.preflight import check_problem
from scripts.run_campaign import save


def main():
    source=json.loads((ROOT/"datasets/problem.json").read_text(encoding="utf-8"))
    target=ROOT/"datasets/scaling-hd-v2";target.mkdir(exist_ok=True)
    manifests=[]
    for size in [500,1000]:
        seed=20260918+size;rng=random.Random(seed);p=copy.deepcopy(source)
        divisions=sorted({j["divisionId"] for j in source["jobs"]})
        counts={d:sum(j["divisionId"]==d for j in source["jobs"]) for d in divisions}
        scaled={d:math.floor(counts[d]*size/len(source["jobs"])) for d in divisions}
        for d in sorted(divisions,key=lambda d:-(counts[d]*size/len(source["jobs"])-scaled[d]))[:size-sum(scaled.values())]:scaled[d]+=1
        p["jobs"]=[];p["workers"]=[]
        for d in divisions:
            sj=[j for j in source["jobs"] if j["divisionId"]==d]
            sw=[w for w in source["workers"] if w["divisionId"]==d]
            for i in range(scaled[d]):
                j=copy.deepcopy(rng.choice(sj));j.update(id=f"scale-{size}-{d}-job-{i:04}",synthetic=True,syntheticSourceJobId=j["id"]);p["jobs"].append(j)
            for i in range(math.ceil(len(sw)*scaled[d]/len(sj))):
                w=copy.deepcopy(sw[i%len(sw)]);w.update(id=f"scale-{size}-{d}-worker-{i:04}",synthetic=True,syntheticSourceWorkerId=w["id"]);p["workers"].append(w)
        p.update(id=f"synthetic-strict-hd-{size}",syntheticScenario=True,scalingGenerationSeed=seed,
            scalingSourceDatasetVersion=source["datasetVersion"],
            scalingModel="Independent demand resampling by division with replacement at existing road nodes; proportional worker replication, same windows and HD; no spatial extrapolation.")
        p["datasetVersion"]=fingerprint({"jobs":p["jobs"],"workers":p["workers"],"seed":seed,"source":source["datasetVersion"]})
        audit=check_problem(p)
        if audit["status"]!="READY":raise RuntimeError(audit)
        save(target/f"{size}.json",p)
        manifests.append({"jobs":size,"workers":len(p["workers"]),"divisions":scaled,"seed":seed,"preflight":audit,
            "meanWindowWidthMinutes":sum(j["windowEnd"]-j["windowStart"] for j in p["jobs"])/size/60,
            "windowWidthAtMost120MinutesShare":sum(j["windowEnd"]-j["windowStart"]<=7200 for j in p["jobs"])/size,
            "jobSkills":dict(Counter(j["requiredSkill"] for j in p["jobs"])),
            "workerSkills":dict(Counter(s for w in p["workers"] for s in w["skills"])),
            "hdRequirements":dict(Counter(s for j in p["jobs"] for s in j["requiredQualifications"])),
            "transport":dict(Counter(w["transportMode"] for w in p["workers"])),
            "uniqueJobLocations":len({j["locationId"] for j in p["jobs"]}),
            "matrixNodesStored":len(p["travelTimeMatrices"]["car"]),"directedArcsStored":sum(len(r) for r in p["travelTimeMatrices"]["car"].values()),
            "matrixVersion":p["matrixVersion"],"datasetVersion":p["datasetVersion"],"problemFingerprint":fingerprint(p)})
    save(target/"manifest.json",{"scenarios":manifests,"limitation":"Repeated addresses create legitimate co-located visits with zero travel between them. This tests demand/crew count scaling on the original geography, not a larger city or newly geocoded customers."})
    print(json.dumps([{k:m[k] for k in ["jobs","workers","seed","uniqueJobLocations"]} for m in manifests]))


if __name__=="__main__":main()
