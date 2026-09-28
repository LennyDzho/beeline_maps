"""Small experimental ALNS: two removal and two feasible insertion operators.

The code is intentionally separate from the MVP. Every exported schedule is
independently validated by core.validator, not by this feasibility routine.
"""
import importlib.metadata
import time
from functools import lru_cache

from core.preflight import require_ready
from core.solution_model import dominating_weights


def solve(problem, policy, time_limit, seed, initial_solution=None, fixed_activities=None):
    require_ready(problem)
    if policy != "PRIMARY" or problem.get("eventAt") is not None or problem.get("protectedActivities") or problem.get("fixedActivities") or initial_solution or fixed_activities:
        raise NotImplementedError("Experimental ALNS currently implements static PRIMARY")
    import numpy as np
    from alns import ALNS
    from alns.accept import HillClimbing
    from alns.select import RouletteWheel
    from alns.stop import MaxRuntime
    began = time.perf_counter()
    deadline = began + time_limit
    jobs, workers = problem["jobs"], problem["workers"]
    n, nw = len(jobs), len(workers)
    max_arc = max(d for matrix in problem["distanceMatrices"].values() for row in matrix.values() for d in row.values() if d is not None)
    upper = n*max_arc
    weights = dominating_weights([n, nw, upper])
    if n*weights[0] + nw*weights[1] + upper >= 2**52:
        raise ValueError("Scalar objective exceeds exact float integer range used by ALNS selection")
    eligible = [[wi for wi, w in enumerate(workers)
        if j["divisionId"] == w["divisionId"] and j["requiredSkill"] in w["skills"]
        and (j.get("requiredTransportMode") is None or j["requiredTransportMode"] == w["transportMode"])
        and set(j.get("requiredQualifications", [])) <= set(w.get("qualifications", []))
        and set(j.get("requiredEquipment", [])) <= set(w.get("equipment", []))] for j in jobs]

    @lru_cache(maxsize=100000)
    def schedule(wi, order):
        w = workers[wi]
        location, clock = w["startLocationId"], max(w["shiftStart"], w["availableAt"])
        distance, visits = 0, []
        mode = w["transportMode"]
        for ji in order:
            if wi not in eligible[ji]:
                return None
            j = jobs[ji]
            t = problem["travelTimeMatrices"][mode].get(location, {}).get(j["locationId"])
            d = problem["distanceMatrices"][mode].get(location, {}).get(j["locationId"])
            if t is None or d is None:
                return None
            start = max(clock+t, j["windowStart"], j["releaseTime"])
            clock = start+j["serviceDuration"]
            if start > j["windowEnd"] or clock > w["shiftEnd"]:
                return None
            visits.append((ji, start, clock))
            distance += d
            location = j["locationId"]
        return distance, tuple(visits)

    class State:
        def __init__(self, routes):
            self.routes = tuple(tuple(r) for r in routes)
            self.served = sum(map(len, self.routes))
            self.cost = weights[0]*(n-self.served) + weights[1]*sum(bool(r) for r in self.routes)
            self.cost += sum(schedule(wi, r)[0] for wi, r in enumerate(self.routes))

        def objective(self):
            return self.cost

    def options(routes, ji):
        alternatives = []
        for wi in eligible[ji]:
            order = routes[wi]
            old_distance = schedule(wi, order)[0]
            for pos in range(len(order)+1):
                candidate = order[:pos] + (ji,) + order[pos:]
                candidate_schedule = schedule(wi, candidate)
                if candidate_schedule is not None:
                    delta = candidate_schedule[0]-old_distance+weights[1]*int(not order)
                    alternatives.append((delta, wi, pos))
        return sorted(alternatives)

    def repair(state, rng, regret=False, **kwargs):
        routes = list(state.routes)
        missing = set(range(n)) - {i for route in routes for i in route}
        if not regret:
            # A full global re-sort after every insertion makes construction
            # cubic. Use deterministic urgency/eligibility order and cheapest
            # feasible position; regret-2 remains a separate repair operator.
            for ji in sorted(missing, key=lambda j: (len(eligible[j]), jobs[j]["windowEnd"], -jobs[j]["serviceDuration"], j)):
                if time.perf_counter() >= deadline:
                    break
                alternatives = options(routes, ji)
                if alternatives:
                    _, wi, pos = alternatives[0]
                    routes[wi] = routes[wi][:pos]+(ji,)+routes[wi][pos:]
            return State(routes)
        while missing and time.perf_counter() < deadline:
            candidates = []
            for ji in sorted(missing, key=lambda j: (len(eligible[j]), jobs[j]["windowEnd"], j)):
                if time.perf_counter() >= deadline:
                    break
                alternatives = options(routes, ji)
                if not alternatives:
                    continue
                delta, wi, pos = alternatives[0]
                regret_value = alternatives[1][0]-delta if len(alternatives) > 1 else weights[1]+upper+1
                key = (-regret_value, delta, ji) if regret else (delta, jobs[ji]["windowEnd"], ji)
                candidates.append((key, ji, wi, pos))
            if not candidates:
                break
            _, ji, wi, pos = min(candidates)
            routes[wi] = routes[wi][:pos]+(ji,)+routes[wi][pos:]
            missing.remove(ji)
        return State(routes)

    def random_removal(state, rng, **kwargs):
        assigned = [j for route in state.routes for j in route]
        if not assigned:
            return state
        count = min(len(assigned), max(1, int(len(assigned)*rng.uniform(0.1, 0.25))))
        removed = set(map(int, rng.choice(assigned, count, replace=False)))
        routes = [tuple(j for j in r if j not in removed) for r in state.routes]
        # External directed matrices need not obey a triangle inequality.
        # A removal can make the new shortcut infeasible; remove that route
        # entirely so the repair operator receives a feasible partial state.
        routes = [r if schedule(wi, r) is not None else () for wi, r in enumerate(routes)]
        return State(routes)

    def route_removal(state, rng, **kwargs):
        used = [wi for wi, r in enumerate(state.routes) if r]
        if not used:
            return state
        routes = list(state.routes)
        routes[int(rng.choice(used))] = ()
        return State(routes)

    rng = np.random.default_rng(seed)
    initial = repair(State([()]*nw), rng)
    construction_ms = (time.perf_counter()-began)*1000
    iterations = 0
    best = initial
    remaining = deadline-time.perf_counter()
    if remaining > 0:
        algorithm = ALNS(rng)
        algorithm.add_destroy_operator(random_removal)
        algorithm.add_destroy_operator(route_removal)
        algorithm.add_repair_operator(repair, name="greedy_insertion")
        algorithm.add_repair_operator(lambda s, r, **kw: repair(s, r, regret=True, **kw), name="regret2_insertion")
        result = algorithm.iterate(initial, RouletteWheel([5, 2, 1, 0.5], 0.8, 2, 2), HillClimbing(), MaxRuntime(remaining))
        best = result.best_state
        iterations = len(result.statistics.objectives)-1
    routes, assigned = [], set()
    for wi, order in enumerate(best.routes):
        if not order:
            continue
        w = workers[wi]
        visits = [{"jobId": jobs[ji]["id"], "start": start, "finish": finish} for ji, start, finish in schedule(wi, order)[1]]
        assigned.update(v["jobId"] for v in visits)
        routes.append({"workerId": w["id"], "startLocationId": w["startLocationId"],
            "departure": max(w["shiftStart"], w["availableAt"]), "visits": visits})
    return {"status": "FEASIBLE", "routes": routes, "unassigned": [j["id"] for j in jobs if j["id"] not in assigned],
        "seed": seed, "solverVersion": importlib.metadata.version("alns"), "solverObjective": best.cost,
        "runtime": {"solverWallTimeMs": (time.perf_counter()-began)*1000, "constructionTimeMs": construction_ms},
        "rawDiagnostics": {"weights": weights, "distanceUpperBoundMetres": upper, "iterations": iterations,
            "destroyOperators": ["random_removal", "route_removal"], "repairOperators": ["greedy_insertion", "regret2_insertion"],
            "acceptance": "HillClimbing", "selection": "RouletteWheel", "limitations": "Initial experimental operators, not a tuned ALNS implementation"}}
