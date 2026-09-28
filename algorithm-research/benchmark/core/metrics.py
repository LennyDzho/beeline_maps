"""Compute comparable metrics only from independently valid solutions."""

import statistics

from .validator import validate


def calculate_metrics(problem, solution):
    validation = validate(problem, solution)
    if validation["totalHardViolations"]:
        return {"status": "FAIL_INVALID_SOLUTION", "hardViolations": validation["totalHardViolations"],
                "validation": validation, "eligibleForComparison": False}
    jobs = {j["id"]: j for j in problem["jobs"]}
    workers = {w["id"]: w for w in problem["workers"]}
    assignments = {}
    distance = travel = waiting = service = 0
    used = set()
    route_metrics = []
    for route in solution["routes"]:
        wid = route["workerId"]
        if route["visits"]:
            used.add(wid)
        worker = workers[wid]
        mode, node, last = worker["transportMode"], route["startLocationId"], route["departure"]
        rm = {"workerId": wid, "distanceMetres": 0, "travelSeconds": 0, "waitingSeconds": 0, "serviceSeconds": 0}
        for pos, visit in enumerate(route["visits"]):
            job = jobs[visit["jobId"]]
            arc_time = problem["travelTimeMatrices"][mode][node][job["locationId"]]
            arc_distance = problem["distanceMatrices"][mode][node][job["locationId"]]
            rm["distanceMetres"] += arc_distance
            rm["travelSeconds"] += arc_time
            rm["waitingSeconds"] += visit["start"] - last - arc_time
            rm["serviceSeconds"] += job["serviceDuration"]
            assignments[job["id"]] = {**visit, "workerId": wid, "position": pos}
            node, last = job["locationId"], visit["finish"]
        distance += rm["distanceMetres"]
        travel += rm["travelSeconds"]
        waiting += rm["waitingSeconds"]
        service += rm["serviceSeconds"]
        route_metrics.append(rm)
    emergencies = []
    for job in jobs.values():
        if job["isEmergency"]:
            visit = assignments.get(job["id"])
            emergencies.append({"jobId": job["id"], "served": visit is not None,
                "responseDelaySeconds": visit["start"] - job["releaseTime"] if visit else None,
                "completionDelaySeconds": visit["finish"] - job["releaseTime"] if visit else None})
    responses = [x["responseDelaySeconds"] / 60 for x in emergencies if x["served"]]
    completions = [x["completionDelaySeconds"] / 60 for x in emergencies if x["served"]]
    previous = problem.get("previousSolution")
    replanning = {k: None for k in ["reassignments", "workerChanges", "orderChanges", "scheduleChanges", "removedAssignments", "newWorkersActivated", "maxScheduleShiftMinutes"]}
    if previous is not None:
        committed = {a["jobId"] for a in problem.get("pastActivities", [])}
        previously_used = {r["workerId"] for r in previous["routes"] if r["visits"]} | {a["workerId"] for a in problem.get("pastActivities", [])}
        old = {v["jobId"]: {**v, "workerId": r["workerId"], "position": p}
               for r in previous["routes"] for p, v in enumerate(r["visits"]) if v["jobId"] not in committed}
        common = old.keys() & assignments.keys()
        # Pairwise relative order avoids counting shifts caused solely by inserting a new job.
        order_changes = set()
        for a in common:
            for b in common:
                if a < b and old[a]["workerId"] == old[b]["workerId"] == assignments[a]["workerId"] == assignments[b]["workerId"]:
                    if (old[a]["position"] < old[b]["position"]) != (assignments[a]["position"] < assignments[b]["position"]):
                        order_changes.update([a, b])
        shifts = [abs(assignments[j]["start"] - old[j]["start"]) / 60 for j in common]
        worker_changes = sum(old[j]["workerId"] != assignments[j]["workerId"] for j in common)
        replanning.update(reassignments=worker_changes, workerChanges=worker_changes, orderChanges=len(order_changes),
            scheduleChanges=sum(assignments[j]["start"] != old[j]["start"] for j in common),
            removedAssignments=len(old.keys() - assignments.keys()),
            newWorkersActivated=len(used - previously_used),
            maxScheduleShiftMinutes=max(shifts, default=0))
    past_workers = {a["workerId"] for a in problem.get("pastActivities", [])}
    return {
        "status": solution["status"], "eligibleForComparison": True,
        "hardViolations": 0, **{f"H{i:02d}Violations": 0 for i in range(1, 13)},
        "jobsTotal": len(jobs), "served": len(assignments), "unassigned": len(jobs) - len(assignments),
        "servedPercent": 100 * len(assignments) / len(jobs) if jobs else None,
        "workersUsed": len(used | past_workers), "remainingDayWorkersUsed": len(used),
        "committedJobs": len(problem.get("pastActivities", [])),
        "wholeDayServed": len(assignments)+len(problem.get("pastActivities", [])),
        "distanceScope": "remaining-day" if problem.get("eventAt") is not None else "initial-plan",
        "distanceMetres": distance, "distanceKm": distance / 1000,
        "travelMinutes": travel / 60, "waitingMinutes": waiting / 60, "serviceMinutes": service / 60,
        "emergencyTotal": len(emergencies), "emergencyServed": len(responses),
        "emergencyUnassigned": len(emergencies) - len(responses), "emergencies": emergencies,
        "meanResponseDelay": statistics.mean(responses) if responses else None,
        "medianResponseDelay": statistics.median(responses) if responses else None,
        "maxResponseDelay": max(responses) if responses else None,
        "meanCompletionDelay": statistics.mean(completions) if completions else None,
        "maxCompletionDelay": max(completions) if completions else None,
        **replanning, "routeMetrics": route_metrics, "validationTimeMs": validation["validationTimeMs"],
    }
