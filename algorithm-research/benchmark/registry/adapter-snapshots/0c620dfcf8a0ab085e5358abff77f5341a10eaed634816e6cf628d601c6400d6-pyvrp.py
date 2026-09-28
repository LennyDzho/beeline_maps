"""PyVRP 0.14 static PRIMARY adapter; hard eligibility via load dimensions."""
import importlib.metadata
import time

from core.preflight import require_ready
from core.solution_model import dominating_weights


def eligible(job, worker):
    return (job["divisionId"] == worker["divisionId"] and job["requiredSkill"] in worker["skills"]
        and (job.get("requiredTransportMode") is None or job["requiredTransportMode"] == worker["transportMode"])
        and set(job.get("requiredQualifications", [])) <= set(worker.get("qualifications", []))
        and set(job.get("requiredEquipment", [])) <= set(worker.get("equipment", [])))


def solve(problem, policy, time_limit, seed, initial_solution=None, fixed_activities=None):
    require_ready(problem)
    if policy != "PRIMARY" or problem.get("eventAt") is not None or problem.get("protectedActivities") or problem.get("fixedActivities") or fixed_activities or initial_solution:
        raise NotImplementedError("Static PRIMARY is the only policy currently implemented in this adapter")
    from pyvrp import Model
    from pyvrp.stop import MaxRuntime
    began = time.perf_counter()
    jobs, workers = problem["jobs"], problem["workers"]
    if len({w["transportMode"] for w in workers}) != 1:
        raise NotImplementedError("Uniform transport scenario only")
    mode = workers[0]["transportMode"]
    n, nw = len(jobs), len(workers)
    distance = problem["distanceMatrices"][mode]
    duration = problem["travelTimeMatrices"][mode]
    upper = n * max((d for row in distance.values() for d in row.values() if d is not None), default=0)
    weights = dominating_weights([n, nw, upper])
    if n*weights[0] + nw*weights[1] + upper >= 2**62:
        raise ValueError("Proven objective bounds exceed safe int64")
    model = Model()
    node_ids = list(dict.fromkeys(w["startLocationId"] for w in workers)) + [j["locationId"] for j in jobs] + ["__open_end__"]
    coordinates = {w["startLocationId"]: w["startCoordinates"] for w in workers}
    coordinates.update({j["locationId"]: j["coordinates"] for j in jobs})
    coordinates["__open_end__"] = {"lat": 0, "lon": 0}
    locations = {nid: model.add_location(int(coordinates[nid]["lon"]*100000), int(coordinates[nid]["lat"]*100000), name=nid) for nid in node_ids}
    depots = {nid: model.add_depot(locations[nid], tw_early=0, tw_late=86400) for nid in dict.fromkeys(w["startLocationId"] for w in workers)}
    end = model.add_depot(locations["__open_end__"], tw_early=0, tw_late=86400)
    for job in jobs:
        # Dimension k has capacity zero on worker k. Only incompatible jobs
        # deliver one unit in that dimension. Other dimensions have capacity N,
        # which cannot bind any route of <= N jobs. Thus no real capacity rule
        # is introduced, and each incompatibility is exactly a hard constraint.
        model.add_client(locations[job["locationId"]], delivery=[int(not eligible(job, w)) for w in workers],
            service_duration=job["serviceDuration"], tw_early=max(job["windowStart"], job["releaseTime"]),
            tw_late=job["windowEnd"], prize=weights[0], required=False, name=job["id"])
    for wi, w in enumerate(workers):
        model.add_vehicle_type(num_available=1, capacity=[0 if k == wi else n for k in range(nw)],
            start_depot=depots[w["startLocationId"]], end_depot=end, fixed_cost=weights[1],
            tw_early=max(w["shiftStart"], w["availableAt"]), tw_late=w["shiftEnd"],
            shift_duration=w["shiftEnd"]-max(w["shiftStart"], w["availableAt"]), max_distance=upper,
            unit_distance_cost=1, unit_duration_cost=0, name=w["id"])
    for a in node_ids:
        for b in node_ids:
            if a == b or b == "__open_end__":
                d = t = 0
            else:
                d, t = distance.get(a, {}).get(b), duration.get(a, {}).get(b)
                if d is None or t is None:
                    # Finite infeasibility sentinels exceed proven route bounds.
                    # These arcs cannot occur in a feasible solution.
                    d, t = upper+1, 86401
            model.add_edge(locations[a], locations[b], distance=d, duration=t)
    result = model.solve(MaxRuntime(time_limit), seed=seed, display=False, collect_stats=False)
    runtime = {"solverWallTimeMs": (time.perf_counter()-began)*1000}
    common = {"seed": seed, "solverVersion": importlib.metadata.version("pyvrp"), "runtime": runtime,
        "rawDiagnostics": {"weights": weights, "distanceUpperBoundMetres": upper,
            "eligibilityEncoding": "one zero-capacity dimension per worker; all other capacities N",
            "nativeFeasible": result.is_feasible()}}
    if not result.is_feasible():
        return {**common, "status": "NO_SOLUTION_FOUND", "routes": [], "unassigned": [j["id"] for j in jobs]}
    routes, assigned = [], set()
    for native in result.best.routes():
        worker = workers[native.vehicle_type()]
        visits = []
        for activity in native.schedule():
            if activity.is_client():
                job = jobs[activity.idx]
                visits.append({"jobId": job["id"], "start": activity.start_time, "finish": activity.end_time})
                assigned.add(job["id"])
        if visits:
            routes.append({"workerId": worker["id"], "startLocationId": worker["startLocationId"], "departure": native.start_time(), "visits": visits})
    return {**common, "status": "FEASIBLE", "routes": routes,
        "unassigned": [j["id"] for j in jobs if j["id"] not in assigned], "solverObjective": result.cost()}
