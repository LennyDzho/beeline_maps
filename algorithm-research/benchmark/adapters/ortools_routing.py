"""Primary static-plan adapter. Dynamic and emergency objectives are not claimed."""

import importlib.metadata
import time

from core.preflight import require_ready
from core.solution_model import dominating_weights


def solve(problem, policy, time_limit, seed, initial_solution=None, fixed_activities=None):
    require_ready(problem)
    if policy != "PRIMARY" or problem.get("eventAt") is not None or problem.get("protectedActivities") or problem.get("fixedActivities") or fixed_activities or initial_solution:
        raise NotImplementedError("This adapter currently implements only PRIMARY static planning")
    from ortools.constraint_solver import pywrapcp, routing_enums_pb2
    began = time.perf_counter()
    jobs, workers = problem["jobs"], problem["workers"]
    if len({w["transportMode"] for w in workers}) != 1:
        raise NotImplementedError("This first adapter requires the explicitly uniform car scenario")
    mode = workers[0]["transportMode"]
    nodes = [j["locationId"] for j in jobs] + list(dict.fromkeys(w["startLocationId"] for w in workers)) + ["__open_end__"]
    index = {node: i for i, node in enumerate(nodes)}
    manager = pywrapcp.RoutingIndexManager(len(nodes), len(workers),
        [index[w["startLocationId"]] for w in workers], [len(nodes)-1]*len(workers))
    model = pywrapcp.RoutingModel(manager)
    finite = [d for row in problem["distanceMatrices"][mode].values() for d in row.values() if d is not None]
    maximum_distance = len(jobs) * max(finite, default=0)
    # Open routes use exactly one physical incoming arc per served job.
    weights = dominating_weights([len(jobs), len(workers), maximum_distance])
    if sum(a*b for a, b in zip([len(jobs), len(workers), maximum_distance], weights)) >= 2**62:
        raise ValueError("Proven lexicographic scalar does not fit safe int64 range")

    def arc(a, b, matrix):
        if b == len(nodes)-1:
            return 0
        return matrix.get(nodes[a], {}).get(nodes[b])

    def cost(a, b):
        na, nb = manager.IndexToNode(a), manager.IndexToNode(b)
        value = arc(na, nb, problem["distanceMatrices"][mode])
        return 0 if value is None else value  # Such arcs are explicitly forbidden below.

    cost_index = model.RegisterTransitCallback(cost)
    model.SetArcCostEvaluatorOfAllVehicles(cost_index)
    for vehicle in range(len(workers)):
        model.SetFixedCostOfVehicle(weights[1], vehicle)

    def duration(a, b):
        na, nb = manager.IndexToNode(a), manager.IndexToNode(b)
        service = jobs[na]["serviceDuration"] if na < len(jobs) else 0
        travel = arc(na, nb, problem["travelTimeMatrices"][mode])
        return service + (0 if travel is None else travel)

    duration_index = model.RegisterTransitCallback(duration)
    model.AddDimension(duration_index, 86400, 86400, False, "Time")
    times = model.GetDimensionOrDie("Time")
    for vehicle, worker in enumerate(workers):
        available = max(worker["shiftStart"], worker["availableAt"])
        times.CumulVar(model.Start(vehicle)).SetRange(available, worker["shiftEnd"])
        times.CumulVar(model.End(vehicle)).SetRange(available, worker["shiftEnd"])
        model.AddVariableMinimizedByFinalizer(times.CumulVar(model.Start(vehicle)))
    for ji, job in enumerate(jobs):
        ni = manager.NodeToIndex(ji)
        times.CumulVar(ni).SetRange(max(job["windowStart"], job["releaseTime"]), job["windowEnd"])
        allowed = [wi for wi, w in enumerate(workers)
                   if w["divisionId"] == job["divisionId"] and job["requiredSkill"] in w["skills"]
                   and (job.get("requiredTransportMode") is None or job["requiredTransportMode"] == w["transportMode"])
                   and set(job.get("requiredQualifications", [])) <= set(w.get("qualifications", []))
                   and set(job.get("requiredEquipment", [])) <= set(w.get("equipment", []))]
        if allowed:
            # OR-Tools 9.15's Windows SWIG binding rejects Python lists for
            # SetAllowedVehiclesForIndex(absl::Span). Restrict the same domain
            # directly, retaining -1 for an unassigned optional job.
            for vehicle in range(len(workers)):
                if vehicle not in allowed:
                    model.VehicleVar(ni).RemoveValue(vehicle)
        else:
            model.ActiveVar(ni).SetValue(0)
        model.AddDisjunction([ni], weights[0])
        model.AddVariableMinimizedByFinalizer(times.CumulVar(ni))
    for a in range(model.Size()):
        for ji in range(len(jobs)):
            b = manager.NodeToIndex(ji)
            if a == b:
                continue  # The self-loop marks a dropped optional job.
            na, nb = manager.IndexToNode(a), manager.IndexToNode(b)
            if arc(na, nb, problem["travelTimeMatrices"][mode]) is None or arc(na, nb, problem["distanceMatrices"][mode]) is None:
                model.NextVar(a).RemoveValue(b)
    params = pywrapcp.DefaultRoutingSearchParameters()
    params.first_solution_strategy = routing_enums_pb2.FirstSolutionStrategy.PARALLEL_CHEAPEST_INSERTION
    params.local_search_metaheuristic = routing_enums_pb2.LocalSearchMetaheuristic.GUIDED_LOCAL_SEARCH
    params.time_limit.FromMilliseconds(max(1, int(time_limit*1000)))
    params.sat_parameters.random_seed = seed
    result = model.SolveWithParameters(params)
    if result is None:
        return {"status": "NO_SOLUTION_FOUND", "routes": [], "unassigned": [j["id"] for j in jobs],
                "seed": seed, "solverVersion": importlib.metadata.version("ortools"),
                "runtime": {"solverWallTimeMs": (time.perf_counter()-began)*1000},
                "rawDiagnostics": {"routingStatus": model.status()}}
    routes, assigned = [], set()
    for wi, worker in enumerate(workers):
        ni = model.Start(wi)
        route = {"workerId": worker["id"], "startLocationId": worker["startLocationId"],
                 "departure": result.Value(times.CumulVar(ni)), "visits": []}
        ni = result.Value(model.NextVar(ni))
        while not model.IsEnd(ni):
            job = jobs[manager.IndexToNode(ni)]
            start = result.Value(times.CumulVar(ni))
            route["visits"].append({"jobId": job["id"], "start": start, "finish": start+job["serviceDuration"]})
            assigned.add(job["id"])
            ni = result.Value(model.NextVar(ni))
        if route["visits"]:
            routes.append(route)
    return {"status": "FEASIBLE", "routes": routes, "unassigned": [j["id"] for j in jobs if j["id"] not in assigned],
            "seed": seed, "solverVersion": importlib.metadata.version("ortools"),
            "solverObjective": result.ObjectiveValue(), "runtime": {"solverWallTimeMs": (time.perf_counter()-began)*1000},
            "rawDiagnostics": {"routingStatus": model.status(), "weights": weights,
                               "distanceUpperBoundMetres": maximum_distance,
                               "seedScope": "SAT subsolver parameter; not a promise of seeded Routing local search"}}
