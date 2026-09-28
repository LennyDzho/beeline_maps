"""PyVRP route search plus application scheduling and emergency refinement.

PyVRP proposes assignments/orders using a relaxation of disjoint windows and
breaks. The scheduler below accepts only exact feasible schedules. A bounded
insertion/relocation search compares the application's lexicographic objectives,
including emergency delay (not a native PyVRP objective). No other solver runs.
"""
import importlib.metadata
import time

from solver import validate


def after_breaks(start, duration, breaks):
    for begin, end in sorted(breaks):
        if start < end and start + duration > begin:
            start = end
    return start


def schedule(jobs, agent, order):
    """Earliest feasible schedule for a fixed order; waiting can span breaks."""
    if len(order) > agent.get("maxJobs", len(jobs)):
        return None
    previous, now = len(jobs), agent["start"]
    travel_total = distance_total = 0
    visits = []
    for index in order:
        job = jobs[index]
        fixed = job.get("fixed")
        if agent["id"] not in job["eligibleAgentIds"] or (fixed and fixed["agentId"] != agent["id"]):
            return None
        travel, distance = agent["durations"][previous][index], agent["distances"][previous][index]
        if travel is None or distance is None:
            return None
        arrival = after_breaks(now, travel, agent["breaks"]) + travel
        start = None
        for early, late in sorted(job["windows"]):
            candidate = after_breaks(max(arrival, early, job["releaseAt"]), job["serviceSeconds"], agent["breaks"])
            if fixed:
                candidate = max(candidate, fixed["start"])
                if candidate != fixed["start"] or after_breaks(candidate, job["serviceSeconds"], agent["breaks"]) != candidate:
                    continue
            if candidate <= late:
                start = candidate
                break
        if start is None:
            return None
        now = start + job["serviceSeconds"]
        if now > agent["end"]:
            return None
        visits.append({"jobId": job["id"], "start": start, "arrival": arrival})
        travel_total += travel
        distance_total += distance
        previous = index
    if order:
        travel, distance = agent["durations"][previous][-1], agent["distances"][previous][-1]
        if travel is None or distance is None:
            return None
        now = after_breaks(now, travel, agent["breaks"]) + travel
        travel_total += travel
        distance_total += distance
    if now > agent["end"] or travel_total > agent.get("maxTravelSeconds", 10**18) or distance_total > agent.get("maxDistanceMeters", 10**18):
        return None
    return {"agentId": agent["id"], "shiftId": agent["shiftId"], "visits": visits, "end": now,
            "distance": distance_total, "engaged": agent.get("alreadyEngaged", False)}


def score(jobs_by_id, routes, policy):
    visits = [v for route in routes for v in route["visits"]]
    emergencies = [v for v in visits if jobs_by_id[v["jobId"]]["emergency"]]
    delay = sum(v["start"] - jobs_by_id[v["jobId"]]["releaseAt"] for v in emergencies)
    staff = sum(bool(r["visits"]) and not r["engaged"] for r in routes)
    return (-len(visits), -len(emergencies), *( (staff, delay) if policy == "emergency_staff/v1" else (delay, staff)),
            sum(r["distance"] for r in routes))


def native_orders(jobs, agents, horizon, deadline):
    from pyvrp import Model
    from pyvrp.stop import MaxRuntime

    model = Model()
    locations = [model.add_location(i, 0) for i in range(len(jobs) + 2)]
    start = model.add_depot(locations[-2], tw_early=0, tw_late=horizon)
    end = model.add_depot(locations[-1], tw_early=0, tw_late=horizon)
    maximum = max((v for a in agents for row in a["distances"] for v in row if v is not None), default=0)
    distance_bound = (len(jobs) + len(agents)) * maximum
    staff_cost = distance_bound + 1
    emergency_prize = (len(agents) + 1) * staff_cost
    coverage_prize = (sum(j["emergency"] for j in jobs) + 1) * emergency_prize
    # PyVRP also computes infeasibility penalties internally: keep headroom.
    if (len(jobs) + 1) * (coverage_prize + emergency_prize) >= 2**52:
        raise ValueError("PyVRP objective exceeds safe range; split independent departments")
    client_jobs = []
    for i, job in enumerate(jobs):
        windows = [(max(a, job["releaseAt"]), b) for a, b in job["windows"] if max(a, job["releaseAt"]) <= b]
        if not windows or not job["eligibleAgentIds"]:
            if job.get("fixed"):
                raise ValueError("Fixed job has no feasible window or agent")
            continue
        fixed = job.get("fixed")
        model.add_client(locations[i], delivery=1, service_duration=job["serviceSeconds"],
            tw_early=fixed["start"] if fixed else min(a for a, _ in windows),
            tw_late=fixed["start"] if fixed else max(b for _, b in windows),
            prize=coverage_prize + int(job["emergency"]) * emergency_prize, required=bool(fixed), name=job["id"])
        client_jobs.append(i)
    if not client_jobs:
        return [[] for _ in agents]
    for agent in agents:
        profile = model.add_profile(name=agent["id"])
        model.add_vehicle_type(num_available=1, capacity=agent.get("maxJobs", len(jobs)), start_depot=start, end_depot=end,
            fixed_cost=0 if agent.get("alreadyEngaged") else staff_cost, tw_early=agent["start"], tw_late=agent["end"],
            start_late=agent["start"], shift_duration=agent["end"]-agent["start"],
            max_distance=agent.get("maxDistanceMeters", distance_bound), profile=profile, name=agent["id"])
        for i, origin in enumerate(locations):
            for k, destination in enumerate(locations):
                if i == k:
                    model.add_edge(origin, destination, distance=0, duration=0, profile=profile)
                    continue
                duration, distance = agent["durations"][i][k], agent["distances"][i][k]
                allowed = k >= len(jobs) or (agent["id"] in jobs[k]["eligibleAgentIds"] and
                    (not jobs[k].get("fixed") or jobs[k]["fixed"]["agentId"] == agent["id"]))
                model.add_edge(origin, destination, distance=distance if distance is not None else 0,
                    duration=duration if duration is not None and distance is not None and allowed else horizon+1, profile=profile)
    remaining = deadline - time.perf_counter()
    if remaining <= 0:
        raise ValueError("PyVRP model construction exceeded search budget")
    result = model.solve(MaxRuntime(max(0.01, remaining * 0.65)), seed=0, display=False, collect_stats=False)
    orders = [[] for _ in agents]
    for route in result.best.routes():
        orders[route.vehicle_type()] = [client_jobs[s.idx] for s in route.schedule() if s.is_client()]
    return orders


def solve(data):
    jobs, agents, horizon = validate(data)
    # Import before starting the search budget; HTTP has a separate hard limit.
    import pyvrp  # noqa: F401
    began = time.perf_counter()
    budget = max(0.1, data["timeLimitMs"] / 1000)
    deadline = began + budget
    native = native_orders(jobs, agents, horizon, deadline)
    by_id = {j["id"]: j for j in jobs}
    policy = data["policy"]
    orders = [sorted([i for i,j in enumerate(jobs) if j.get("fixed", {}).get("agentId") == a["id"]],
                     key=lambda i: jobs[i]["fixed"]["start"]) for a in agents]
    routes = [schedule(jobs, a, order) for a, order in zip(agents, orders)]
    if any(r is None for r in routes):
        return {"version":1, "engine":"pyvrp", "policy":policy, "status":"no_solution_found", "routes":[], "unassigned":[j["id"] for j in jobs]}

    # Preserve each native route if its exact schedule (including fixed work)
    # is valid. Repair only invalid routes and omitted work by insertion.
    for v, order in enumerate(native):
        if not set(orders[v]) <= set(order):
            continue
        candidate = schedule(jobs, agents[v], order)
        if candidate is not None:
            orders[v], routes[v] = order, candidate

    def insert(index, base_orders, base_routes, stop_at):
        best = None
        for v, agent in enumerate(agents):
            if agent["id"] not in jobs[index]["eligibleAgentIds"]:
                continue
            for position in range(len(base_orders[v]) + 1):
                if time.perf_counter() >= stop_at:
                    return best
                order = base_orders[v][:position] + [index] + base_orders[v][position:]
                route = schedule(jobs, agent, order)
                if route is None:
                    continue
                candidate_routes = base_routes[:v] + [route] + base_routes[v+1:]
                quality = score(by_id, candidate_routes, policy)
                if best is None or quality < best[0]:
                    best = (quality, v, order, route)
        return best

    assigned = {i for order in orders for i in order}
    pending = sorted((i for i in range(len(jobs)) if i not in assigned), key=lambda i: (not jobs[i]["emergency"], min((b for _, b in jobs[i]["windows"]), default=horizon)))
    for i in pending:
        candidate = insert(i, orders, routes, deadline)
        if candidate:
            _, v, orders[v], routes[v] = candidate

    # Lexicographic relocation also moves an emergency to an idle brigade when
    # its earlier start outranks staffing. Fixed activities are never removed.
    movable = sorted((i for i,j in enumerate(jobs) if not j.get("fixed")), key=lambda i: not jobs[i]["emergency"])
    improved = True
    while improved and time.perf_counter() < deadline:
        improved = False
        for i in movable:
            if time.perf_counter() >= deadline:
                break
            base_orders, base_routes = orders.copy(), routes.copy()
            owner = next((v for v, order in enumerate(orders) if i in order), None)
            if owner is not None:
                base_orders[owner] = [j for j in orders[owner] if j != i]
                base_routes[owner] = schedule(jobs, agents[owner], base_orders[owner])
                if base_routes[owner] is None:
                    continue  # Directed road matrices need not be metric.
            candidate = insert(i, base_orders, base_routes, deadline)
            if candidate and candidate[0] < score(by_id, routes, policy):
                _, v, base_orders[v], base_routes[v] = candidate
                orders, routes = base_orders, base_routes
                improved = True
            elif owner is None and jobs[i]["emergency"]:
                # At full capacity an emergency may replace ordinary work,
                # retaining coverage and improving the second objective.
                for v, order in enumerate(orders):
                    for position, displaced in enumerate(order):
                        if time.perf_counter() >= deadline:
                            break
                        if jobs[displaced].get("fixed") or jobs[displaced]["emergency"]:
                            continue
                        replacement = order[:position] + [i] + order[position+1:]
                        route = schedule(jobs, agents[v], replacement)
                        if route is None:
                            continue
                        updated = routes[:v] + [route] + routes[v+1:]
                        if score(by_id, updated, policy) < score(by_id, routes, policy):
                            orders[v], routes = replacement, updated
                            improved = True
                            break
                    if any(i in order for order in orders):
                        break
    assigned = {i for order in orders for i in order}
    return {"version":1, "engine":"pyvrp", "policy":policy, "status":"feasible",
            "solverVersion":importlib.metadata.version("pyvrp"),
            "routes":[{k:r[k] for k in ("agentId", "shiftId", "visits", "end")} for r in routes if r["visits"]],
            "unassigned":[j["id"] for i,j in enumerate(jobs) if i not in assigned],
            "durationMs":round((time.perf_counter()-began)*1000), "refinement":"application-emergency-relocation/v1"}
