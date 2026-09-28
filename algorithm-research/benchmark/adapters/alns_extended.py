"""Experimental ALNS for explicit lexicographic policies and protected visits.

Kept separate from the frozen static baseline. Objective comparisons use Python
integers throughout ALNS/HillClimbing; no floating scalar precision is discarded.
"""
import importlib.metadata
import time
from functools import lru_cache

from core.preflight import require_ready
from core.solution_model import dominating_weights
from .linear_reference import eligible


def solve(problem, policy, time_limit, seed, initial_solution=None, fixed_activities=None):
    require_ready(problem)
    import numpy as np
    from alns import ALNS
    from alns.accept import HillClimbing
    from alns.select import RouletteWheel
    from alns.stop import MaxRuntime
    began=time.perf_counter(); deadline=began+time_limit
    jobs,workers=problem["jobs"],problem["workers"]
    ji={j["id"]:i for i,j in enumerate(jobs)}; wi={w["id"]:i for i,w in enumerate(workers)}
    n,nw=len(jobs),len(workers)
    anchors={a["jobId"]:a for a in problem.get("fixedActivities",[])+problem.get("protectedActivities",[])+(fixed_activities or [])}
    old_workers={a["workerId"] for a in problem.get("pastActivities",[])}
    emergency_total=sum(j["isEmergency"] for j in jobs)
    upper=n*max(d for m in problem["distanceMatrices"].values() for row in m.values() for d in row.values() if d is not None)
    bounds={"unassigned":n,"emergencyUnassigned":emergency_total,"delay":emergency_total*86400,"workers":nw,"distance":upper}
    levels={"PRIMARY":["unassigned","workers","distance"],
        "POLICY_FAST_RESPONSE":["unassigned","emergencyUnassigned","delay","workers","distance"],
        "POLICY_MIN_STAFF":["unassigned","emergencyUnassigned","workers","delay","distance"]}[policy]
    weights=dict(zip(levels,dominating_weights([bounds[k] for k in levels])))
    allowed=[[k for k,w in enumerate(workers) if eligible(j,w)
        and (j["id"] not in anchors or anchors[j["id"]]["workerId"]==w["id"])] for j in jobs]

    @lru_cache(maxsize=100000)
    def schedule(k,order):
        w=workers[k]; mode=w["transportMode"]
        node=w.get("currentLocationId") or w["startLocationId"]
        at=max(w["shiftStart"],w["availableAt"],problem.get("eventAt") or 0)
        distance=delay=emergencies=0; visits=[]
        for i in order:
            if k not in allowed[i]: return None
            j=jobs[i]
            t=problem["travelTimeMatrices"][mode].get(node,{}).get(j["locationId"])
            d=problem["distanceMatrices"][mode].get(node,{}).get(j["locationId"])
            if t is None or d is None: return None
            start=max(at+t,j["windowStart"],j["releaseTime"])
            if j["id"] in anchors:
                fixed=anchors[j["id"]]
                if start>fixed["start"] or fixed["finish"]!=fixed["start"]+j["serviceDuration"]: return None
                start=fixed["start"]
            at=start+j["serviceDuration"]
            if start>j["windowEnd"] or at>w["shiftEnd"]: return None
            distance+=d; emergencies+=int(j["isEmergency"])
            if j["isEmergency"]: delay+=start-j["releaseTime"]
            visits.append((i,start,at)); node=j["locationId"]
        return distance,tuple(visits),delay,emergencies

    def route_score(k,order):
        d,_,delay,e=schedule(k,order)
        return d*weights["distance"]+delay*weights.get("delay",0)-e*weights.get("emergencyUnassigned",0) \
            -len(order)*weights["unassigned"]+int(bool(order) and workers[k]["id"] not in old_workers)*weights["workers"]

    class State:
        def __init__(self,routes):
            self.routes=tuple(tuple(r) for r in routes)
            self.cost=n*weights["unassigned"]+emergency_total*weights.get("emergencyUnassigned",0)+len(old_workers)*weights["workers"]
            self.cost+=sum(route_score(k,r) for k,r in enumerate(self.routes))
        def objective(self): return self.cost

    mandatory=[tuple(ji[a["jobId"]] for a in sorted(anchors.values(),key=lambda a:a["start"]) if a["workerId"]==w["id"]) for w in workers]
    warm=initial_solution or problem.get("previousSolution")
    warm_used=False
    routes=list(mandatory)
    if warm:
        by_worker={r["workerId"]:r for r in warm.get("routes",[])}
        for k,w in enumerate(workers):
            order=tuple(ji[v["jobId"]] for v in by_worker.get(w["id"],{}).get("visits",[]) if v["jobId"] in ji and k in allowed[ji[v["jobId"]]])
            for i in mandatory[k]:
                if i not in order:
                    candidates=[order[:pos]+(i,)+order[pos:] for pos in range(len(order)+1)]
                    feasible=[r for r in candidates if schedule(k,r) is not None]
                    order=min(feasible,key=lambda r:route_score(k,r)) if feasible else order
            while order and (schedule(k,order) is None or not set(mandatory[k])<=set(order)):
                removable=[i for i in reversed(order) if jobs[i]["id"] not in anchors]
                if not removable: break
                order=tuple(i for i in order if i!=removable[0])
            if schedule(k,order) is not None and set(mandatory[k])<=set(order):
                routes[k]=order; warm_used=warm_used or bool(order)
    if any(schedule(k,r) is None for k,r in enumerate(routes)):
        return {"status":"NO_SOLUTION_FOUND","routes":[],"unassigned":[j["id"] for j in jobs],"seed":seed,
            "solverVersion":importlib.metadata.version("alns"),"runtime":{"solverWallTimeMs":(time.perf_counter()-began)*1000},
            "rawDiagnostics":{"reason":"Could not construct a feasible protected initial state; not an infeasibility proof"}}

    def options(routes,i):
        alternatives=[]
        for k in allowed[i]:
            old=routes[k]; base=route_score(k,old)
            for pos in range(len(old)+1):
                if time.perf_counter()>=deadline: break
                order=old[:pos]+(i,)+old[pos:]
                if schedule(k,order) is not None: alternatives.append((route_score(k,order)-base,k,pos))
        return sorted(alternatives)

    def repair(state,rng,regret=False,**kwargs):
        routes=list(state.routes); missing=set(range(n))-{i for r in routes for i in r}
        def priority(i): return (not jobs[i]["isEmergency"] if policy!="PRIMARY" else False,len(allowed[i]),jobs[i]["windowEnd"],i)
        if not regret:
            for i in sorted(missing,key=priority):
                if time.perf_counter()>=deadline: break
                alternatives=options(routes,i)
                if alternatives:
                    _,k,pos=alternatives[0]; routes[k]=routes[k][:pos]+(i,)+routes[k][pos:]
        else:
            while missing and time.perf_counter()<deadline:
                candidates=[]
                for i in sorted(missing,key=priority):
                    if time.perf_counter()>=deadline: break
                    alternatives=options(routes,i)
                    if alternatives:
                        delta,k,pos=alternatives[0]
                        regret_value=alternatives[1][0]-delta if len(alternatives)>1 else weights["unassigned"]
                        candidates.append((-regret_value,delta,i,k,pos))
                if not candidates: break
                _,_,i,k,pos=min(candidates); routes[k]=routes[k][:pos]+(i,)+routes[k][pos:]; missing.remove(i)
        return State(routes)

    iterations=0
    def remove(state,rng,whole_route=False,**kwargs):
        nonlocal iterations
        iterations+=1
        choices=[i for r in state.routes for i in r if jobs[i]["id"] not in anchors]
        if not choices: return state
        if whole_route:
            occupied=[k for k,r in enumerate(state.routes) if any(jobs[i]["id"] not in anchors for i in r)]
            k=int(rng.choice(occupied)); removed={i for i in state.routes[k] if jobs[i]["id"] not in anchors}
        else:
            size=min(len(choices),max(1,int(len(choices)*rng.uniform(.1,.25))))
            removed=set(map(int,rng.choice(choices,size,replace=False)))
        routes=[]
        for k,r in enumerate(state.routes):
            shortened=tuple(i for i in r if i not in removed)
            # Nonmetric shortcuts may be infeasible; keep that route intact.
            routes.append(shortened if schedule(k,shortened) is not None else r)
        return State(routes)

    rng=np.random.default_rng(seed); initial=repair(State(routes),rng); best=initial
    remaining=deadline-time.perf_counter()
    if remaining>0:
        algorithm=ALNS(rng)
        algorithm.add_destroy_operator(remove,name="unprotected_random_removal")
        algorithm.add_destroy_operator(lambda s,r,**kw:remove(s,r,whole_route=True,**kw),name="unprotected_route_removal")
        algorithm.add_repair_operator(repair,name="policy_greedy_insertion")
        algorithm.add_repair_operator(lambda s,r,**kw:repair(s,r,regret=True,**kw),name="regret2_insertion")
        best=algorithm.iterate(initial,RouletteWheel([5,2,1,.5],.8,2,2),HillClimbing(),MaxRuntime(remaining)).best_state
    output=[]; assigned=set()
    for k,r in enumerate(best.routes):
        if not r: continue
        w=workers[k]; visits=[{"jobId":jobs[i]["id"],"start":start,"finish":end} for i,start,end in schedule(k,r)[1]]
        assigned.update(v["jobId"] for v in visits)
        output.append({"workerId":w["id"],"startLocationId":w.get("currentLocationId") or w["startLocationId"],
            "departure":max(w["shiftStart"],w["availableAt"],problem.get("eventAt") or 0),"visits":visits})
    return {"status":"FEASIBLE","routes":output,"unassigned":[j["id"] for j in jobs if j["id"] not in assigned],
        "pastActivities":problem.get("pastActivities",[]),"seed":seed,"solverVersion":importlib.metadata.version("alns"),
        "solverObjective":best.cost,"runtime":{"solverWallTimeMs":(time.perf_counter()-began)*1000},
        "rawDiagnostics":{"variant":"extended-protected-lexicographic","objectiveIntegerArithmetic":"Python arbitrary precision; HillClimbing and ALNS compare integers directly",
            "weights":weights,"bounds":bounds,"warmStartUsed":warm_used,"fixedVisitCount":len(anchors),"iterations":iterations}}
