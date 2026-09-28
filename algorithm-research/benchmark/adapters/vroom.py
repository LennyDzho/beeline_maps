"""VROOM through its official local Python binding; static PRIMARY, one thread."""
import importlib.metadata
import time
from datetime import timedelta

from core.preflight import require_ready
from .linear_reference import eligible


def solve(problem, policy, time_limit, seed, initial_solution=None, fixed_activities=None):
    require_ready(problem)
    if policy != "PRIMARY" or problem.get("eventAt") is not None or problem.get("fixedActivities") or problem.get("protectedActivities") or fixed_activities or initial_solution:
        raise NotImplementedError("VROOM adapter currently implements static PRIMARY")
    import vroom
    began = time.perf_counter()
    jobs, workers = problem["jobs"], problem["workers"]
    nodes = sorted({w["startLocationId"] for w in workers} | {j["locationId"] for j in jobs})
    indices = {x: i for i, x in enumerate(nodes)}
    max_distance = max(d for m in problem["distanceMatrices"].values() for row in m.values() for d in row.values() if d is not None)
    upper = len(jobs)*max_distance
    # Every route has one incoming arc per job and no return. One activation
    # therefore outweighs the largest total distance of any feasible plan.
    fixed = upper+1
    if fixed*len(workers)+upper >= 2**32 or (fixed*len(workers)+upper)*360000 >= 2**63:
        raise ValueError("VROOM user/scaled cost would overflow; cannot preserve objective safely")
    import numpy as np
    def native_matrix(values):
        data = np.asarray(values, dtype="uint32")
        # NumPy on Windows exposes uint32 as buffer format L, while this
        # wheel expects I. Reinterpret the same four-byte unsigned integers.
        return vroom._vroom.Matrix(memoryview(data).cast("B").cast("I", shape=data.shape))
    model = vroom.Input()
    for mode in {w["transportMode"] for w in workers}:
        tm, dm = problem["travelTimeMatrices"][mode], problem["distanceMatrices"][mode]
        def travel(a, b):
            t, d = tm.get(a, {}).get(b), dm.get(a, {}).get(b)
            return 86401 if t is None or d is None else t
        durations = [[travel(a, b) for b in nodes] for a in nodes]
        distances = [[dm.get(a, {}).get(b) or 0 for b in nodes] for a in nodes]
        # Missing arcs have duration > every possible shift, so the zero cost
        # is never reachable. They are never silently treated as zero travel.
        model.set_durations_matrix(mode, native_matrix(durations))
        model.set_costs_matrix(mode, native_matrix(distances))
        model.set_distances_matrix(mode, native_matrix(distances))
    for wi, w in enumerate(workers):
        model.add_vehicle(vroom.Vehicle(wi+1, start=indices[w["startLocationId"]],
            profile=w["transportMode"], skills={i+1 for i,j in enumerate(jobs) if eligible(j,w)},
            time_window=vroom.TimeWindow(max(w["availableAt"], w["shiftStart"]), w["shiftEnd"]),
            costs=vroom.VehicleCosts(fixed=fixed)))
    for i, j in enumerate(jobs):
        lower = max(j["windowStart"], j["releaseTime"])
        if lower > j["windowEnd"]:
            continue
        model.add_job(vroom.Job(i+1, indices[j["locationId"]], default_service=j["serviceDuration"],
            skills={i+1}, priority=1, time_windows=[vroom.TimeWindow(lower, j["windowEnd"]) ]))
    build_ms = (time.perf_counter()-began)*1000
    native = model.solve(exploration_level=5, nb_threads=1, timeout=timedelta(seconds=time_limit))
    result = native.to_dict()
    routes, assigned = [], set()
    for nr in result["routes"]:
        w = workers[nr["vehicle"]-1]
        route = {"workerId": w["id"], "startLocationId": w["startLocationId"],
            "departure": nr["steps"][0]["arrival"], "visits": []}
        for step in nr["steps"]:
            if step["type"] != "job":
                continue
            j = jobs[step["id"]-1]
            start = step["arrival"]+step["waiting_time"]
            route["visits"].append({"jobId": j["id"], "start": start, "finish": start+j["serviceDuration"]})
            assigned.add(j["id"])
        if route["visits"]:
            routes.append(route)
    return {"status": "FEASIBLE", "routes": routes, "unassigned": [j["id"] for j in jobs if j["id"] not in assigned],
        "seed": seed, "solverVersion": "pyvroom-"+importlib.metadata.version("pyvroom"), "bindingVersion": importlib.metadata.version("pyvroom"),
        "solverObjective": result["summary"]["cost"],
        "runtime": {"solverWallTimeMs": (time.perf_counter()-began)*1000, "modelBuildTimeMs": build_ms},
        "rawDiagnostics": {"nativeSummary": result["summary"], "fixedVehicleCost": fixed,
            "distanceUpperBoundMetres": upper, "seedScope": "No random seed exposed by binding; repeat ID only",
            "objective": "Equal positive priority maximizes count, then fixed activation plus exact distance costs"}}
