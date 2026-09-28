"""T01–T23: solver runs separated explicitly from common integration checks.

NOT_IMPLEMENTED is retained during research; it is never mislabeled UNSUPPORTED.
Each result stores the exact controlled input, native output and external checks.
"""
import argparse
import copy
import csv
import json
import sys
from datetime import datetime,timezone
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
sys.path[:0]=[str(ROOT),str(ROOT/"tests")]
from test_core import fixture
from core.metrics import calculate_metrics
from core.validator import validate
from core.problem_model import fingerprint
from core.replanning import freeze_at,change_log
from core.publication import PlanStore,StalePlanError
from runner import run_once,adapter_source


def base():
    p,s=fixture();p.update(id="regression",datasetVersion="controlled-v1")
    return p,s


def emergency():
    p,_=base();p["workers"][0]["availableAt"]=11*3600
    p["jobs"][0].update(isEmergency=True,releaseTime=11*3600,windowStart=0,windowEnd=86399,serviceDuration=4800)
    p["travelTimeMatrices"]["car"]["s"]["j"]=900
    p.update(eventAt=11*3600,previousSolution={"routes":[]})
    return p


def solver_case(test):
    p,s=base();expected={"served":1};policy="PRIMARY"
    if test=="T02":
        p["jobs"][0].update(windowStart=11*3600+50*60,windowEnd=12*3600)
        expected["finishAfter"]=12*3600
    elif test=="T03":
        p["jobs"][0].update(windowStart=11*3600+50*60,windowEnd=12*3600)
        p["workers"][0]["shiftEnd"]=12*3600+20*60;expected["served"]=0
    elif test in {"T04","T05"}:
        p["workers"].append({**p["workers"][0],"id":"eligible","startLocationId":"k"})
        p["distanceMatrices"]["car"]["s"]["j"]=1;p["distanceMatrices"]["car"]["k"]["j"]=10000
        p["workers"][0].update({"skills":["other"]} if test=="T04" else {"divisionId":"other"})
        expected["workerId"]="eligible"
    elif test=="T06":
        p["workers"][0]["transportMode"]="walk";p["jobs"][0]["requiredTransportMode"]="car"
        p["travelTimeMatrices"]["walk"]=p["travelTimeMatrices"]["car"]
        p["distanceMatrices"]["walk"]=p["distanceMatrices"]["car"]
        expected.update(served=0,reason="TRANSPORT")
    elif test in {"T07","T08"}:
        p["jobs"]=[{**p["jobs"][0],"id":f"job-{i}","serviceDuration":3600,"windowStart":9*3600,"windowEnd":13*3600} for i in range(8)]
        hours=[4,3,1] if test=="T07" else [4,4,4]
        p["workers"]=[{**p["workers"][0],"id":f"worker-{i}","shiftEnd":(9+h)*3600} for i,h in enumerate(hours)]
        for matrix in p["travelTimeMatrices"].values():
            for row in matrix.values():
                for key in row:row[key]=0
        expected.update(served=8,workersUsed=3 if test=="T07" else 2)
    elif test=="T09":
        p["jobs"][0].update(windowStart=10*3600,windowEnd=10*3600)
        p["workers"][0]["shiftEnd"]=10*3600+2400
        p["travelTimeMatrices"]["car"]["j"]["s"]=50000
    elif test=="T10":
        p["jobs"].append({**p["jobs"][0],"id":"k","locationId":"k"});expected.update(served=2,workersUsed=1)
    elif test in {"T13","T14","T17"}:
        p=emergency();policy="POLICY_FAST_RESPONSE";expected.update(responseMinutes=15)
        if test!="T13":
            p["jobs"].append({**p["jobs"][0],"id":"k","locationId":"k","isEmergency":False,"serviceDuration":1200})
            p["travelTimeMatrices"]["car"]["j"]["k"]=900
            key="fixedActivities" if test=="T14" else "protectedActivities"
            p[key]=[{"jobId":"k","workerId":"w","start":13*3600,"finish":13*3600+1200}]
            expected["served"]=2
    elif test=="T15":
        p=emergency();policy="POLICY_FAST_RESPONSE"
        for matrix in p["travelTimeMatrices"].values():
            for row in matrix.values():
                for key in row:row[key]=0
        normal=[{**p["jobs"][0],"id":f"normal-{i}","serviceDuration":1800,"isEmergency":False} for i in range(3)]
        p["jobs"]+=normal
        p["previousSolution"]={"routes":[{"workerId":"w","startLocationId":"s","departure":11*3600,"visits":[{"jobId":j["id"],"start":11*3600+1800*i,"finish":11*3600+1800*(i+1)} for i,j in enumerate(normal)]}]}
        expected.update(served=4,responseMinutes=0,scheduleChanges=3,changeReasons=3)
    elif test=="T16":
        p=freeze_at(p,s,9*3600+30*60)
        p["jobs"]=[{**base()[0]["jobs"][0],"id":"k","locationId":"k","isEmergency":True,"releaseTime":p["eventAt"],"windowStart":0,"windowEnd":86399}]
        policy="POLICY_FAST_RESPONSE";expected["startNotBefore"]=s["routes"][0]["visits"][0]["finish"]+1200
    elif test=="T18":
        p=emergency();policy="POLICY_FAST_RESPONSE"
        p["workers"][0].update(availableAt=16*3600,shiftEnd=22*3600)
        p["workers"].append({**p["workers"][0],"id":"spare","availableAt":11*3600})
        p["pastActivities"]=[{"workerId":"w","jobId":"committed","start":10*3600,"finish":16*3600}]
        expected.update(workersUsed=2,responseMinutes=15)
    elif test=="T19":
        p=emergency();policy="POLICY_FAST_RESPONSE"
        p["jobs"].append({**p["jobs"][0],"id":"k","locationId":"k","serviceDuration":1200})
        for matrix in p["travelTimeMatrices"].values():
            for row in matrix.values():
                for key in row:row[key]=0
        expected.update(served=2,emergencyServed=2,responseMinutes=10)
    elif test=="T22":
        p["travelTimeMatrices"]["car"]["s"]["j"]=None;p["distanceMatrices"]["car"]["s"]["j"]=None;expected["served"]=0
    else:raise ValueError(test)
    p["id"]="regression-"+test
    return p,policy,expected


def common_case(test):
    p,s=base()
    if test=="T01":
        m=calculate_metrics(p,s)
        assert m["waitingMinutes"]==20 and m["serviceMinutes"]==40 and m["hardViolations"]==0
        return {"inputProblem":p,"providedPlan":s,"metrics":m,"note":"Known arrival 09:40 is checked by the shared metrics; solvers may otherwise choose a later departure"}
    if test in {"T11","T12"}:
        p["jobs"].append({**p["jobs"][0],"id":"k","locationId":"k"})
        start=s["routes"][0]["visits"][0]["finish"]+(300 if test=="T11" else -1200)
        s["routes"][0]["visits"].append({"jobId":"k","start":start,"finish":start+2400})
        validation=validate(p,s);key="H08" if test=="T11" else "H07";assert validation[key]>0
        return {"inputProblem":p,"providedInvalidPlan":s,"validation":validation,
            "manualPresentationContract":{"label":"Назначена вручную","severity":"error","color":"red","autoPublishAllowed":False} if test=="T12" else None,
            "note":"Research integration contract, not a test of MVP UI rendering"}
    if test=="T20":
        empty={"routes":[]};first=change_log(empty,s,"initial");removed=change_log(s,empty,"manual",first)
        moved=copy.deepcopy(s);moved["routes"][0]["workerId"]="other";history=change_log(empty,moved,"manual",removed)
        assert first[0]["reason"] is None and history[-1]["reason"] is not None and len(history)==3
        return {"history":history}
    if test=="T21":
        moved=copy.deepcopy(s);v=moved["routes"][0]["visits"][0];v["start"]+=300;v["finish"]+=300
        history=change_log(s,moved,"manual_time");assert history[0]["before"]["start"]+300==history[0]["after"]["start"] and history[0]["reason"]
        return {"history":history}
    if test=="T23":
        store=PlanStore();store.seed("a",1,s);store.seed("b",2,s);before=store.snapshot()
        try:store.publish({"a":{},"b":{}},{"a":1,"b":1})
        except StalePlanError:pass
        else:raise AssertionError("Stale plan was accepted")
        assert store.snapshot()==before
        return {"before":before,"afterRejectedPublication":store.snapshot(),"atomicRollback":True,"storage":"isolated SQLite :memory:"}
    raise ValueError(test)


def assess(record,expected):
    if record["status"]=="ADAPTER_NOT_IMPLEMENTED":return "NOT_IMPLEMENTED",record.get("reason")
    if record["status"]=="FAIL_INVALID_SOLUTION":return "FAIL_INVALID_SOLUTION","Independent validator rejected the solution"
    m=record.get("metrics") or {};s=record.get("solution") or {}
    if not m.get("eligibleForComparison"):return "FAIL","No feasible incumbent returned for a tiny controlled case"
    for key,val in expected.items():
        if key in {"served","workersUsed","emergencyServed","scheduleChanges"} and m.get(key)!=val:return "FAIL",f"Expected {key}={val}, got {m.get(key)}"
        if key=="responseMinutes" and m.get("meanResponseDelay")!=val:return "FAIL",f"Expected mean response {val}, got {m.get('meanResponseDelay')}"
        if key=="workerId" and s["routes"][0]["workerId"]!=val:return "FAIL","Assigned to an ineligible worker"
        if key=="finishAfter" and not s["routes"][0]["visits"][0]["finish"]>val:return "FAIL","Could not schedule service finishing beyond start window"
        if key=="startNotBefore" and s["routes"][0]["visits"][0]["start"]<val:return "FAIL","Started before committed travel/service completed"
        if key=="reason" and not any(e["code"]==val for e in s.get("unassignedExplanations",[])):return "FAIL","Missing explanatory reason"
        if key=="changeReasons" and sum(e["reason"] is not None for e in s.get("changeLog",[]))<val:return "FAIL","Missing change reasons"
    return "PASS",None


def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument("--solvers",nargs="+");parser.add_argument("--budget",type=float,default=2)
    parser.add_argument("--tests",nargs="+",help="Specific T identifiers; default T01–T23")
    args=parser.parse_args();solvers=args.solvers or [c["id"] for c in json.loads((ROOT/"registry/candidates.json").read_text(encoding="utf-8"))]
    common={"T01","T11","T12","T20","T21","T23"};folder=ROOT/"results/regression";folder.mkdir(exist_ok=True)
    for solver in solvers:
        for number in range(1,24):
            test=f"T{number:02d}";timestamp=datetime.now(timezone.utc).isoformat()
            if args.tests and test not in args.tests:continue
            result={"solver":solver,"test":test,"timestamp":timestamp,"budget":args.budget,"component":"COMMON_INTEGRATION" if test in common else "SOLVER_ADAPTER","solverExecuted":test not in common}
            try:
                if test in common:
                    result.update(status="PASS",evidence=common_case(test))
                else:
                    p,policy,expected=solver_case(test);record=run_once(p,solver,policy,args.budget,1)
                    status,reason=assess(record,expected)
                    result.update(status=status,reason=reason,inputProblem=p,expected=expected,record=record)
                    if test=="T04" and status=="PASS":
                        # Same broad category is insufficient: both HD types
                        # are required inside BK. The closest crew has only one.
                        from core.competencies import token
                        hd=copy.deepcopy(p);j=hd["jobs"][0]
                        j.update(bkType="installation",requiredHdTypes=["connect","equipment"],requiredQualifications=[token("installation",t) for t in ["connect","equipment"]])
                        for w in hd["workers"]:
                            w["skills"]=[j["requiredSkill"]]
                            kinds=["connect","equipment"] if w["id"]==expected["workerId"] else ["connect"]
                            w["supportedHdTypes"]={"installation":kinds};w["qualifications"]=[token("installation",t) for t in kinds]
                        hd["competencyModel"]="bk-scoped-hd-v2"
                        second=run_once(hd,solver,policy,args.budget,1)
                        result["hdConjunctionCase"]={"inputProblem":hd,"record":second}
                        status,reason=assess(second,expected);result.update(status=status,reason=reason)
                    if test=="T03" and status=="PASS":
                        late=copy.deepcopy(p);late["workers"][0]["shiftEnd"]=18*3600
                        late["jobs"][0].update(windowStart=10*3600,windowEnd=12*3600)
                        late["travelTimeMatrices"]["car"]["s"]["j"]=3*3600+60
                        second=run_once(late,solver,policy,args.budget,1)
                        result["lateArrivalCase"]={"inputProblem":late,"record":second}
                        status,reason=assess(second,{"served":0});result.update(status=status,reason=reason)
                    if test=="T18" and status=="PASS":
                        second=run_once(p,solver,"POLICY_MIN_STAFF",args.budget,1)
                        result["secondPolicy"]=second
                        status,reason=assess(second,{"served":1,"workersUsed":1,"responseMinutes":315})
                        result.update(status=status,reason=reason)
            except Exception as error:result.update(status="FAIL",reason=type(error).__name__+": "+str(error))
            path=folder/f"{solver}-{test}-{fingerprint(result)[:16]}.json"
            path.write_text(json.dumps(result,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
            print(json.dumps({k:result.get(k) for k in ["solver","test","status","component","reason"]}),flush=True)
    latest={}
    for path in folder.glob("*.json"):
        r=json.loads(path.read_text(encoding="utf-8"));key=(r["solver"],r["test"])
        if key not in latest or r["timestamp"]>latest[key]["timestamp"]:latest[key]={**r,"evidenceFile":str(path.relative_to(ROOT))}
    rows=[{k:r.get(k) for k in ["solver","test","status","component","solverExecuted","reason","evidenceFile","timestamp"]} for r in sorted(latest.values(),key=lambda r:(r["solver"],r["test"]))]
    with (ROOT/"results/test_matrix.csv").open("w",encoding="utf-8-sig",newline="") as f:
        writer=csv.DictWriter(f,fieldnames=list(rows[0]));writer.writeheader();writer.writerows(rows)
    (ROOT/"results/test_matrix.json").write_text(json.dumps(rows,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")


if __name__=="__main__":main()
