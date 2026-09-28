"""Refuse solver execution when required data is absent or inconsistent."""

import math


class DataNotReady(ValueError):
    pass


def check_problem(problem, require_coordinates=True):
    issues = []

    def issue(code, text, record=None):
        issues.append({"code": code, "message": text, "recordId": record})

    workers, jobs = problem.get("workers", []), problem.get("jobs", [])
    if not workers or not jobs:
        issue("EMPTY_PROBLEM", "Workers and jobs must be present")
    for collection, name in [(workers, "worker"), (jobs, "job")]:
        ids = [r.get("id") for r in collection]
        if None in ids or len(ids) != len(set(ids)):
            issue("INVALID_IDS", f"Duplicate or missing {name} IDs")
    modes = {w.get("transportMode") for w in workers}
    locations = {w.get("startLocationId") for w in workers} | {j.get("locationId") for j in jobs}
    for w in workers:
        wid = w.get("id")
        if w.get("transportMode") not in {"car", "walk", "bicycle", "transit"}:
            issue("TRANSPORT_MISSING", "Worker travel profile must be explicit", wid)
        if not w.get("skills") or not w.get("divisionId"):
            issue("WORKER_IDENTITY", "Division and skills required", wid)
        if not all(isinstance(w.get(k), int) for k in ["shiftStart", "shiftEnd", "availableAt"]) or not 0 <= w["shiftStart"] < w["shiftEnd"] <= 86400:
            issue("SHIFT_MISSING", "Valid integer-second shift required", wid)
        if require_coordinates and not valid_point(w.get("startCoordinates")):
            issue("START_COORDINATES_MISSING", "Start requires verified geocoding", wid)
    for j in jobs:
        jid = j.get("id")
        if require_coordinates and not valid_point(j.get("coordinates")):
            issue("JOB_COORDINATES_MISSING", "Job requires verified building coordinates", jid)
        if not isinstance(j.get("serviceDuration"), int) or j["serviceDuration"] <= 0:
            issue("SERVICE_MISSING", "Positive service duration without travel required", jid)
        if not all(isinstance(j.get(k), int) for k in ["windowStart", "windowEnd", "releaseTime"]) or not 0 <= j["windowStart"] <= j["windowEnd"] < 86400:
            issue("WINDOW_MISSING", "Valid service-start window and release time required", jid)
        if not isinstance(j.get("isEmergency"), bool):
            issue("EMERGENCY_MISSING", "Emergency flag must be explicit", jid)
        # Lack of a compatible worker can be a valid unassigned job, not a data error.
    if not problem.get("matrixVersion"):
        issue("MATRIX_VERSION_MISSING", "Freeze and fingerprint matrices before a solver run")
    for mode in modes:
        for key in ["travelTimeMatrices", "distanceMatrices"]:
            matrix = problem.get(key, {}).get(mode)
            if not isinstance(matrix, dict):
                issue("MATRIX_MISSING", f"{key}/{mode} is absent")
                continue
            # Cross-division paths need not be queried, because assignments cannot cross divisions.
            for division in {w["divisionId"] for w in workers}:
                nodes = {w["startLocationId"] for w in workers if w["divisionId"] == division}
                nodes |= {j["locationId"] for j in jobs if j["divisionId"] == division}
                for origin in nodes:
                    if origin not in matrix:
                        issue("MATRIX_ROW_MISSING", f"{key}/{mode}: {origin}")
                        continue
                    for target in nodes:
                        if target not in matrix[origin]:
                            issue("MATRIX_CELL_MISSING", f"{key}/{mode}: {origin} -> {target}")
                            continue
                        value = matrix[origin][target]
                        # None means a documented unreachable path, never zero by default.
                        if value is not None and (not isinstance(value, int) or value < 0):
                            issue("MATRIX_CELL_INVALID", f"{key}/{mode}: {origin} -> {target}")
                        if origin == target and value != 0:
                            issue("MATRIX_DIAGONAL_INVALID", f"{key}/{mode}: {origin}")
    if problem.get("eventAt") is not None and problem.get("previousSolution") is None:
        issue("PREVIOUS_SOLUTION_MISSING", "Replanning requires a previous plan snapshot")
    workers_by_id = {w.get("id"): w for w in workers}
    jobs_by_id = {j.get("id"): j for j in jobs}
    if problem.get("competencyModel") == "bk-scoped-hd-v2":
        from .competencies import required_tokens, supported_tokens
        for w in workers:
            if not w.get("supportedHdTypes") or supported_tokens(w) != {s for s in w.get("qualifications", []) if s.startswith("hd:")}:
                issue("HD_WORKER_ENCODING", "HD competencies and adapter tokens must agree", w.get("id"))
        for j in jobs:
            if not j.get("bkType") or not j.get("requiredHdTypes"):
                issue("HD_JOB_MISSING", "Exact BK and required HD types are mandatory", j.get("id"))
            elif required_tokens(j) != {s for s in j.get("requiredQualifications", []) if s.startswith("hd:")}:
                issue("HD_JOB_ENCODING", "All HD requirements must reach every adapter", j.get("id"))
    fixed_by_job = {}
    for activity in problem.get("fixedActivities", []) + problem.get("protectedActivities", []):
        jid, wid = activity.get("jobId"), activity.get("workerId")
        if jid not in jobs_by_id or wid not in workers_by_id:
            issue("FIXED_ID_MISSING", "Protected activity must reference an existing remaining job and worker", jid)
        if not all(isinstance(activity.get(k), int) for k in ["start", "finish"]):
            issue("FIXED_TIME_MISSING", "Protected activity requires explicit integer start and finish", jid)
        previous = fixed_by_job.get(jid)
        if previous is not None and any(previous.get(k) != activity.get(k) for k in ["workerId", "start", "finish"]):
            issue("FIXED_CONTRADICTION", "Different protections specify contradictory assignments", jid)
        fixed_by_job[jid] = activity
    return {"status": "READY" if not issues else "BLOCKED_DATA", "issues": issues,
            "jobsTotal": len(jobs), "workersTotal": len(workers), "locationCount": len(locations)}


def valid_point(point):
    if not isinstance(point, dict):
        return False
    return all(isinstance(point.get(k), (float, int)) and math.isfinite(point[k]) and low <= point[k] <= high
               for k, low, high in [("lat", -90, 90), ("lon", -180, 180)])


def require_ready(problem, **kwargs):
    result = check_problem(problem, **kwargs)
    if result["status"] != "READY":
        codes = sorted({issue["code"] for issue in result["issues"]})
        raise DataNotReady("Solver was not started: " + ", ".join(codes))
    return result
