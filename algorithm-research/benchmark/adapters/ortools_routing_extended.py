"""Three exact integer objective hierarchies and immutable visit anchors.

Static benchmark adapter remains frozen. Soft cumul costs price emergency
response; inactive optional visits do not incur that cost in Routing.
"""

import importlib.metadata
import time

from core.preflight import require_ready
from core.solution_model import dominating_weights
from adapters.linear_reference import eligible


def solve(problem, policy, time_limit, seed, initial_solution=None, fixed_activities=None):
    require_ready(problem)
    if policy not in {"PRIMARY", "POLICY_FAST_RESPONSE", "POLICY_MIN_STAFF"}:
        raise ValueError(policy)
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
    emergency_count = sum(j["isEmergency"] for j in jobs)
    delay_bound = sum(max(0, j["windowEnd"]-j["releaseTime"]) for j in jobs if j["isEmergency"])
    if policy == "PRIMARY":
        bounds = [len(jobs), len(workers), maximum_distance]
        weights = dominating_weights(bounds)
        drop_weight, staff_weight, _ = weights
        emergency_weight = response_weight = 0
    else:
        lower = [delay_bound, len(workers)] if policy == "POLICY_FAST_RESPONSE" else [len(workers), delay_bound]
        bounds = [len(jobs), emergency_count, *lower, maximum_distance]
        weights = dominating_weights(bounds)
        drop_weight, emergency_weight = weights[:2]
        response_weight, staff_weight = weights[2:4] if policy == "POLICY_FAST_RESPONSE" else weights[3:1:-1]
    if sum(a*b for a, b in zip(bounds, weights)) >= 2**62:
        raise ValueError("Proven lexicographic scalar does not fit safe int64 range")
    committed_workers = {a["workerId"] for a in problem.get("pastActivities", [])}
    fixed = {a["jobId"]: a for a in problem.get("fixedActivities", []) + problem.get("protectedActivities", []) + list(fixed_activities or [])}

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
        model.SetFixedCostOfVehicle(0 if workers[vehicle]["id"] in committed_workers else staff_weight, vehicle)

    def duration(a, b):
        na, nb = manager.IndexToNode(a), manager.IndexToNode(b)
        service = jobs[na]["serviceDuration"] if na < len(jobs) else 0
        travel = arc(na, nb, problem["travelTimeMatrices"][mode])
        return service + (0 if travel is None else travel)

    duration_index = model.RegisterTransitCallback(duration)
    model.AddDimension(duration_index, 86400, 86400, False, "Time")
    times = model.GetDimensionOrDie("Time")
    for vehicle, worker in enumerate(workers):
        available = max(worker["shiftStart"], worker["availableAt"], problem.get("eventAt") or 0)
        times.CumulVar(model.Start(vehicle)).SetRange(available, worker["shiftEnd"])
        times.CumulVar(model.End(vehicle)).SetRange(available, worker["shiftEnd"])
        model.AddVariableMinimizedByFinalizer(times.CumulVar(model.Start(vehicle)))
    for ji, job in enumerate(jobs):
        ni = manager.NodeToIndex(ji)
        times.CumulVar(ni).SetRange(max(job["windowStart"], job["releaseTime"]), job["windowEnd"])
        allowed = [wi for wi, w in enumerate(workers) if eligible(job, w)]
        if allowed:
            # OR-Tools 9.15's Windows SWIG binding rejects Python lists for
            # SetAllowedVehiclesForIndex(absl::Span). Restrict the same domain
            # directly, retaining -1 for an unassigned optional job.
            for vehicle in range(len(workers)):
                if vehicle not in allowed:
                    model.VehicleVar(ni).RemoveValue(vehicle)
        else:
            model.ActiveVar(ni).SetValue(0)
        if job["id"] in fixed:
            activity = fixed[job["id"]]
            wi = next(i for i,w in enumerate(workers) if w["id"] == activity["workerId"])
            if wi not in allowed or activity["finish"] != activity["start"] + job["serviceDuration"]:
                raise ValueError("Fixed visit conflicts with qualification or service duration")
            model.VehicleVar(ni).SetValue(wi)
            times.CumulVar(ni).SetValue(activity["start"])
        else:
            model.AddDisjunction([ni], drop_weight + emergency_weight * job["isEmergency"])
        if job["isEmergency"] and response_weight:
            times.SetCumulVarSoftUpperBound(ni, job["releaseTime"], response_weight)
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
    warm = initial_solution or problem.get("previousSolution")
    warm_status = "NOT_REQUESTED"
    assignment = None
    if warm:
        by_job = {j["id"]:i for i,j in enumerate(jobs)}
        previous = {r["workerId"]:r for r in warm["routes"]}
        orders = []
        for w in workers:
            order = [by_job[v["jobId"]] for v in previous.get(w["id"], {}).get("visits", [])
                     if v["jobId"] in by_job and eligible(jobs[by_job[v["jobId"]]],w)
                     and (v["jobId"] not in fixed or fixed[v["jobId"]]["workerId"]==w["id"])]
            orders.append(order)
        model.CloseModelWithParameters(params)
        assignment = model.ReadAssignmentFromRoutes(orders, True)
        warm_status = "ACCEPTED" if assignment is not None else "REJECTED_INFEASIBLE_NATIVE_INITIAL_ROUTES"
    result = model.SolveFromAssignmentWithParameters(assignment, params) if assignment is not None else model.SolveWithParameters(params)
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
            "pastActivities": problem.get("pastActivities", []),
            "seed": seed, "solverVersion": importlib.metadata.version("ortools"),
            "solverObjective": result.ObjectiveValue(), "runtime": {"solverWallTimeMs": (time.perf_counter()-began)*1000},
            "rawDiagnostics": {"routingStatus": model.status(), "weights": weights, "bounds": bounds,
                               "warmStart": warm_status, "protectedCount":len(fixed),
                               "distanceUpperBoundMetres": maximum_distance,
                               "seedScope": "SAT subsolver parameter; not a promise of seeded Routing local search"}}
