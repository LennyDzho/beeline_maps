"""Application solver. No database, geocoder or benchmark side effects.

Windows constrain service START. Travel and service cannot cross a break.
All times are integer seconds relative to one UTC horizon; distances are metres.
"""
import importlib.metadata
import time

POLICIES = {"emergency_fast/v1", "emergency_staff/v1"}
MAX_HORIZON = 7 * 86400


def integer(value, label, maximum=MAX_HORIZON):
    if type(value) is not int or not 0 <= value <= maximum:
        raise ValueError(f"Invalid {label}")
    return value


def validate(data):
    if data.get("version") != 1 or data.get("policy") not in POLICIES:
        raise ValueError("Unsupported solver contract or objective policy")
    jobs, agents = data.get("jobs"), data.get("agents")
    if not isinstance(jobs, list) or not isinstance(agents, list) or len(jobs) > 1000 or not 1 <= len(agents) <= 100:
        raise ValueError("Expected up to 1000 jobs and 1..100 agents")
    for records in (jobs, agents):
        ids = [item.get("id") for item in records]
        if any(not isinstance(i, str) or not i or len(i) > 200 for i in ids) or len(set(ids)) != len(ids):
            raise ValueError("Invalid or duplicate IDs")
    horizon = integer(data["horizonSeconds"], "horizon")
    if horizon < 1:
        raise ValueError("Empty horizon")
    integer(data["timeLimitMs"], "search budget", 60000)
    size = len(jobs) + 2
    for agent in agents:
        if type(agent.get("alreadyEngaged", False)) is not bool:
            raise ValueError("Invalid already engaged flag")
        if integer(agent["start"], "shift start", horizon) >= integer(agent["end"], "shift end", horizon):
            raise ValueError("Empty shift")
        for start, end in agent["breaks"]:
            if integer(start, "break start", horizon) >= integer(end, "break end", horizon):
                raise ValueError("Empty break")
        for key in ("durations", "distances"):
            matrix = agent[key]
            if len(matrix) != size or any(len(row) != size for row in matrix):
                raise ValueError("Incomplete directed matrix")
            for row in matrix:
                for value in row:
                    if value is not None:
                        integer(value, key, 10**9)
        for key in ("maxJobs", "maxTravelSeconds", "maxDistanceMeters"):
            if key in agent:
                integer(agent[key], key, 10**9)
    agent_ids = {a["id"] for a in agents}
    for job in jobs:
        if integer(job["serviceSeconds"], "service duration") < 1:
            raise ValueError("Empty service")
        integer(job["releaseAt"], "release", horizon)
        if type(job["emergency"]) is not bool or not set(job["eligibleAgentIds"]) <= agent_ids:
            raise ValueError("Invalid eligibility")
        for start, end in job["windows"]:
            if integer(start, "window start", horizon) > integer(end, "window end", horizon):
                raise ValueError("Inverted window")
        if "fixed" in job:
            fixed = job["fixed"]
            if fixed["agentId"] not in job["eligibleAgentIds"]:
                raise ValueError("Fixed job is not eligible")
            integer(fixed["start"], "fixed start", horizon)
    return jobs, agents, horizon


def hierarchy(jobs, agents, horizon, policy):
    # Every served job has one incoming arc, plus at most one end arc per agent.
    maximum_arc = max((v for a in agents for row in a["distances"] for v in row if v is not None), default=0)
    distance_bound = (len(jobs) + len(agents)) * maximum_arc
    emergency_count = sum(j["emergency"] for j in jobs)
    names, bounds = ["coverage"], [len(jobs)]
    if emergency_count:
        names += ["emergency_coverage"]
        bounds += [emergency_count]
        lower = [("response", emergency_count*horizon), ("staff", len(agents))]
        if policy == "emergency_staff/v1":
            lower.reverse()
        names += [name for name, _ in lower]
        bounds += [bound for _, bound in lower]
    else:
        names += ["staff"]
        bounds += [len(agents)]
    names += ["distance"]
    bounds += [distance_bound]
    weights = [1]*len(bounds)
    for i in range(len(bounds)-2, -1, -1):
        weights[i] = weights[i+1]*(bounds[i+1]+1)
    if sum(w*b for w,b in zip(weights,bounds)) >= 2**62:
        raise ValueError("Exact objective hierarchy exceeds safe int64 range; split independent departments")
    return dict(zip(names, weights)), dict(zip(names, bounds))


def solve(data):
    jobs, agents, horizon = validate(data)
    began = time.perf_counter()
    from ortools.constraint_solver import pywrapcp, routing_enums_pb2
    n, count = len(jobs), len(agents)
    weights, bounds = hierarchy(jobs, agents, horizon, data["policy"])
    manager = pywrapcp.RoutingIndexManager(n+2, count, [n]*count, [n+1]*count)
    model = pywrapcp.RoutingModel(manager)
    cp = model.solver()
    duration_callbacks, travel_callbacks, distance_callbacks = [], [], []
    callbacks = []  # SWIG callbacks must remain alive through Solve.
    for vehicle, agent in enumerate(agents):
        def travel(a, b, agent=agent):
            value = agent["durations"][manager.IndexToNode(a)][manager.IndexToNode(b)]
            distance_value = agent["distances"][manager.IndexToNode(a)][manager.IndexToNode(b)]
            return horizon+1 if value is None or distance_value is None else value
        def duration(a, b, travel=travel):
            node = manager.IndexToNode(a)
            return travel(a, b) + (jobs[node]["serviceSeconds"] if node < n else 0)
        def distance(a, b, agent=agent):
            value = agent["distances"][manager.IndexToNode(a)][manager.IndexToNode(b)]
            return 0 if value is None else value
        callbacks += [travel, duration, distance]
        duration_callbacks.append(model.RegisterTransitCallback(duration))
        travel_callbacks.append(model.RegisterTransitCallback(travel))
        distance_callbacks.append(model.RegisterTransitCallback(distance))
        model.SetArcCostEvaluatorOfVehicle(distance_callbacks[-1], vehicle)
        model.SetFixedCostOfVehicle(0 if agent.get("alreadyEngaged", False) else weights["staff"], vehicle)
    model.AddDimensionWithVehicleTransits(duration_callbacks, horizon, horizon, False, "Time")
    times = model.GetDimensionOrDie("Time")
    model.AddDimensionWithVehicleCapacity(model.RegisterUnaryTransitCallback(lambda i: int(manager.IndexToNode(i) < n)), 0,
        [a.get("maxJobs", n) for a in agents], True, "Jobs")
    model.AddDimensionWithVehicleTransitAndCapacity(travel_callbacks, 0, [a.get("maxTravelSeconds", horizon) for a in agents], True, "Travel")
    model.AddDimensionWithVehicleTransitAndCapacity(distance_callbacks, 0, [a.get("maxDistanceMeters", bounds["distance"]) for a in agents], True, "Distance")
    arrivals = [cp.IntVar(0, horizon, f"arrival_{j}") for j in range(n)]
    for j, job in enumerate(jobs):
        node = manager.NodeToIndex(j)
        start = times.CumulVar(node)
        cp.Add(arrivals[j] <= start)
        model.AddToAssignment(arrivals[j])
        model.AddVariableMinimizedByFinalizer(arrivals[j])
        windows = sorted((max(a,job["releaseAt"]),b) for a,b in job["windows"] if max(a,job["releaseAt"]) <= b)
        if not windows or not job["eligibleAgentIds"]:
            model.ActiveVar(node).SetValue(0)
        else:
            start.SetRange(windows[0][0], max(b for _,b in windows))
            last = windows[0][1]
            for a,b in windows[1:]:
                if a > last+1:
                    start.RemoveInterval(last+1, a-1)
                last = max(last,b)
        for v, agent in enumerate(agents):
            if agent["id"] not in job["eligibleAgentIds"]:
                model.VehicleVar(node).RemoveValue(v)
        if "fixed" in job:
            fixed = job["fixed"]
            model.VehicleVar(node).SetValue(next(v for v,a in enumerate(agents) if a["id"] == fixed["agentId"]))
            start.SetValue(fixed["start"])
        else:
            model.AddDisjunction([node], weights["coverage"] + int(job["emergency"])*weights.get("emergency_coverage", 0))
        if job["emergency"]:
            times.SetCumulVarSoftUpperBound(node, job["releaseAt"], weights["response"])
        model.AddVariableMinimizedByFinalizer(start)
    for v, agent in enumerate(agents):
        start_node, end_node = model.Start(v), model.End(v)
        times.CumulVar(start_node).SetValue(agent["start"])
        times.CumulVar(end_node).SetRange(agent["start"], agent["end"])
        model.AddVariableMinimizedByFinalizer(times.CumulVar(end_node))
        if not agent["breaks"]:
            continue  # Time transit already enforces these arcs; avoid quadratic CP constraints.
        # Select an arrival independently from service start so waiting may span
        # a break while neither travel nor actual service is interrupted.
        origins = [start_node] + [manager.NodeToIndex(j) for j in range(n) if agent["id"] in jobs[j]["eligibleAgentIds"]]
        destinations = [end_node] + [manager.NodeToIndex(j) for j in range(n) if agent["id"] in jobs[j]["eligibleAgentIds"]]
        for b in destinations:
            bj = manager.IndexToNode(b)
            arrival = times.CumulVar(b) if bj == n+1 else arrivals[bj]
            if bj < n:
                for begin,end in agent["breaks"]:
                    cp.Add(cp.IsDifferentCstVar(model.VehicleVar(b),v) + cp.IsLessOrEqualCstVar(times.CumulVar(b)+jobs[bj]["serviceSeconds"],begin)
                        + cp.IsGreaterOrEqualCstVar(times.CumulVar(b),end) >= 1)
            for a in origins:
                if a == b:
                    continue
                aj = manager.IndexToNode(a)
                travel = agent["durations"][aj][bj]
                inactive = cp.IsDifferentCstVar(model.NextVar(a),b) + cp.IsDifferentCstVar(model.VehicleVar(a),v)
                if travel is None or agent["distances"][aj][bj] is None:
                    cp.Add(inactive >= 1)
                    continue
                service = jobs[aj]["serviceSeconds"] if aj < n else 0
                cp.Add(inactive + cp.IsGreaterOrEqualVar(arrival, times.CumulVar(a)+service+travel) >= 1)
                for begin,end in agent["breaks"]:
                    cp.Add(inactive + cp.IsLessOrEqualCstVar(arrival,begin) + cp.IsGreaterOrEqualCstVar(arrival-travel,end) >= 1)
    params = pywrapcp.DefaultRoutingSearchParameters()
    params.first_solution_strategy = routing_enums_pb2.FirstSolutionStrategy.PARALLEL_CHEAPEST_INSERTION
    params.local_search_metaheuristic = routing_enums_pb2.LocalSearchMetaheuristic.GUIDED_LOCAL_SEARCH
    params.time_limit.FromMilliseconds(max(1,data["timeLimitMs"]))
    result = model.SolveWithParameters(params)
    if result is None:
        return {"version":1,"status":"no_solution_found","policy":data["policy"],"routes":[],"unassigned":[j["id"] for j in jobs]}
    routes, assigned = [], set()
    for v,agent in enumerate(agents):
        index = result.Value(model.NextVar(model.Start(v)))
        visits = []
        previous_node, previous_end = n, agent["start"]
        while not model.IsEnd(index):
            j = manager.IndexToNode(index)
            start = result.Value(times.CumulVar(index))
            arrival = result.Value(arrivals[j]) if agent["breaks"] else previous_end + agent["durations"][previous_node][j]
            visits.append({"jobId":jobs[j]["id"],"start":start,"arrival":arrival})
            previous_node, previous_end = j, start + jobs[j]["serviceSeconds"]
            assigned.add(jobs[j]["id"])
            index = result.Value(model.NextVar(index))
        if visits:
            routes.append({"agentId":agent["id"],"shiftId":agent["shiftId"],"visits":visits,"end":result.Value(times.CumulVar(index))})
    return {"version":1,"status":"feasible","policy":data["policy"],"routes":routes,"unassigned":[j["id"] for j in jobs if j["id"] not in assigned],
        "solverVersion":importlib.metadata.version("ortools"),"weights":weights,"bounds":bounds,
        "durationMs":round((time.perf_counter()-began)*1000),"routingStatus":model.status()}


def dispatch(data):
    if not isinstance(data, dict):
        raise ValueError("Expected a solver request object")
    engine = data.get("engine", "ortools")  # Compatibility with protocol v1 clients.
    if engine == "pyvrp":
        from pyvrp_solver import solve as solve_pyvrp
        return solve_pyvrp(data)
    if engine != "ortools":
        raise ValueError("Unknown optimization engine")
    return {**solve(data), "engine": "ortools"}


if __name__ == "__main__":
    import json
    import sys
    try:
        print(json.dumps(dispatch(json.load(sys.stdin)), separators=(",",":")))
    except (ValueError, KeyError, TypeError) as error:
        print(json.dumps({"error":"invalid_request","message":str(error)}))
        sys.exit(2)
