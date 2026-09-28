"""Solver-neutral result helpers; no vendor objective is a cross-solver metric."""


def empty_result(solver, status, seed, diagnostics=None):
    return {"solver": solver, "status": status, "routes": [], "assignments": [],
            "unassigned": [], "timings": {}, "solverObjective": None,
            "runtime": {}, "seed": seed, "solverVersion": None,
            "rawDiagnostics": diagnostics or {}}


def objective_tuple(metrics, policy="PRIMARY"):
    if metrics["hardViolations"]:
        raise ValueError("Invalid plans cannot enter a quality ranking")
    served = -metrics["served"]
    workers, distance = metrics["workersUsed"], metrics["distanceMetres"]
    if policy == "PRIMARY":
        return served, workers, distance
    emergencies = -metrics["emergencyServed"]
    delay = sum(e["responseDelaySeconds"] for e in metrics["emergencies"] if e["responseDelaySeconds"] is not None)
    if policy == "POLICY_FAST_RESPONSE":
        return served, emergencies, delay, workers, distance
    if policy == "POLICY_MIN_STAFF":
        return served, emergencies, workers, delay, distance
    raise ValueError(f"Unknown policy: {policy}")


def dominating_weights(bounds):
    """For nonnegative integer minimisation levels 0..bound, derive exact dominance.

    w[i] = 1 + sum(bound[j] * w[j], j > i).
    Improving level i by one outweighs every possible change in lower levels.
    Adapters must additionally check their own integer/floating precision limits.
    """
    if any(not isinstance(bound, int) or bound < 0 for bound in bounds):
        raise ValueError("Finite nonnegative integer bounds required")
    weights = [0] * len(bounds)
    maximum_lower = 0
    for index in range(len(bounds) - 1, -1, -1):
        weights[index] = maximum_lower + 1
        maximum_lower += bounds[index] * weights[index]
    return weights
