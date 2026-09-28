"""Explicit remaining-day scenarios using one immutable common plan snapshot.

Completed work and already-started travel/service are carried as committed
activities. Their workers only become available at the committed destination
after service ends. This does not teleport an en-route worker to an idle office.
"""
import copy
from .validator import validate
from .problem_model import fingerprint


def freeze_at(problem, solution, event_at):
    validation=validate(problem,solution)
    if validation["totalHardViolations"]:
        raise ValueError("Cannot freeze an invalid plan")
    p=copy.deepcopy(problem)
    p.update(eventAt=event_at,previousSolution=copy.deepcopy(solution),pastActivities=[],fixedActivities=[],protectedActivities=[])
    jobs={j["id"]:j for j in p["jobs"]}; workers={w["id"]:w for w in p["workers"]}
    committed=set()
    for w in workers.values():
        w["availableAt"]=max(event_at,w["availableAt"],w["shiftStart"])
        w["officeLocationId"]=w["startLocationId"]
    for route in solution["routes"]:
        w=workers[route["workerId"]]; node=route["startLocationId"]; departed=route["departure"]
        available=max(event_at,w["shiftStart"])
        for visit in route["visits"]:
            j=jobs[visit["jobId"]]
            travel=p["travelTimeMatrices"][w["transportMode"]][node][j["locationId"]]
            arrival=departed+travel
            if visit["finish"]<=event_at:
                status="completed"
            elif visit["start"]<=event_at<visit["finish"]:
                status="in_progress"
            elif departed<=event_at<arrival:
                status="en_route"
            else:
                # Waiting at the next customer's building is an explicit
                # current location. The unstarted service remains replannable.
                if arrival<=event_at<visit["start"]:
                    node=j["locationId"]
                break
            p["pastActivities"].append({**visit,"workerId":w["id"],"stateAtEvent":status,
                "travelFromLocationId":node,"travelDeparture":departed,"arrival":arrival,
                "locationId":j["locationId"],"immutable":True})
            committed.add(j["id"]); node=j["locationId"]
            available=max(event_at,visit["finish"]); departed=visit["finish"]
            if status!="completed": break
        w["currentLocationId"]=node
        w["startLocationId"]=node
        w["availableAt"]=max(w["availableAt"],available)
        source=next((j["coordinates"] for j in jobs.values() if j["locationId"]==node),None)
        if source is not None: w["startCoordinates"]=copy.deepcopy(source)
    p["jobs"]=[j for j in p["jobs"] if j["id"] not in committed]
    p["snapshotProvenance"]={"eventAt":event_at,"initialProblemFingerprint":fingerprint(problem),
        "previousSolutionFingerprint":fingerprint(solution),"committedJobIds":sorted(committed),
        "travelTimingConvention":"Leave previous service immediately; any remaining waiting occurs at next destination, as in common metrics",
        "pastActivitiesMeaning":"Immutable committed prefix: completed services and any already-started travel/service; some committed finishes are after eventAt"}
    p["id"]=p.get("id","controlled")+"::remaining-day"
    return p


def explain_unassigned(problem,solution):
    jobs={j["id"]:j for j in problem["jobs"]}
    result=[]
    for item in solution["unassigned"]:
        jid=item if isinstance(item,str) else item["jobId"]
        j=jobs[jid]; candidates=problem["workers"]
        checks=[("DIVISION",lambda w:w["divisionId"]==j["divisionId"],"Нет исполнителя нужного подразделения"),
            ("SKILL",lambda w:j["requiredSkill"] in w["skills"],"Нет исполнителя с требуемой квалификацией"),
            ("HD_SKILL",lambda w:not j.get("requiredHdTypes") or set(j["requiredHdTypes"])<=set(w.get("supportedHdTypes",{}).get(j.get("bkType"),[])),"Нет исполнителя со всеми требуемыми HD внутри указанной ВК"),
            ("TRANSPORT",lambda w:not j.get("requiredTransportMode") or j["requiredTransportMode"]==w["transportMode"],"Нет исполнителя с требуемым транспортом"),
            ("RESOURCES",lambda w:set(j.get("requiredQualifications",[]))<=set(w.get("qualifications",[])) and set(j.get("requiredEquipment",[]))<=set(w.get("equipment",[])),"Нет исполнителя с требуемыми допусками или оборудованием")]
        reason={"jobId":jid,"code":"SEARCH_OR_SCHEDULING","text":"В пределах бюджета допустимое назначение не найдено; невозможность не доказана"}
        for code,predicate,text in checks:
            candidates=[w for w in candidates if predicate(w)]
            if not candidates:
                reason.update(code=code,text=text); break
        result.append(reason)
    return result


def change_log(previous,current,event_type,history=None):
    """Changes are an integration concern; first assignment has no choice story."""
    old={v["jobId"]:{**v,"workerId":r["workerId"]} for r in previous.get("routes",[]) for v in r["visits"]}
    new={v["jobId"]:{**v,"workerId":r["workerId"]} for r in current.get("routes",[]) for v in r["visits"]}
    prior=list(history or []); ever={x["jobId"] for x in prior}|set(old)
    added=[]
    for jid in sorted(old.keys()|new.keys()):
        before,after=old.get(jid),new.get(jid)
        if before==after: continue
        first=jid not in ever and after is not None
        added.append({"jobId":jid,"before":before,"after":after,"firstAssignment":first,
            "reason":None if first else {"eventType":event_type,"text":"Назначение изменено после события; значения до и после сохранены"}})
    return prior+added
