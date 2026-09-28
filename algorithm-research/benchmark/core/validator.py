"""Independent validator for service-start windows and open routes.

Visits contain jobId, start, finish. Routes contain workerId, startLocationId,
departure and visits. Times are seconds since local midnight. The validator
recomputes road feasibility directly from the common matrices, never from
vendor-reported arrival/travel/objective values.
"""

import time
from collections import Counter


def validate(problem, solution):
    began = time.perf_counter()
    violations = []
    counts = {f"H{i:02d}": 0 for i in range(1, 13)}
    workers = {w["id"]: w for w in problem["workers"]}
    jobs = {j["id"]: j for j in problem["jobs"]}
    assigned = {}
    route_workers = set()

    def fail(code, message, **details):
        counts[code] += 1
        violations.append({"constraint": code, "message": message, **details})

    for route in solution.get("routes", []):
        wid = route.get("workerId")
        if wid not in workers:
            fail("H09", "Unknown worker", workerId=wid)
            continue
        if wid in route_workers:
            fail("H07", "Multiple route records for one worker", workerId=wid)
        route_workers.add(wid)
        worker = workers[wid]
        start_node = worker.get("currentLocationId") or worker["startLocationId"]
        node = route.get("startLocationId")
        if node != start_node:
            fail("H09", "Wrong route start", workerId=wid, expected=start_node, actual=node)
        departure = route.get("departure")
        if not isinstance(departure, int):
            fail("H06", "Departure time is absent or noninteger", workerId=wid)
            continue
        if departure < worker["shiftStart"] or departure < worker["availableAt"]:
            fail("H06", "Departure before shift or availability", workerId=wid)
        event = problem.get("eventAt")
        if event is not None and departure < event:
            fail("H11", "Remaining-day route departs before event", workerId=wid)
        previous_finish = departure
        prior_intervals = []
        for position, visit in enumerate(route.get("visits", [])):
            jid = visit.get("jobId")
            if jid not in jobs:
                fail("H01", "Unknown job", jobId=jid)
                continue
            if jid in assigned:
                fail("H01", "Job assigned more than once", jobId=jid)
            assigned[jid] = {"workerId": wid, "position": position, **visit}
            job = jobs[jid]
            if worker["divisionId"] != job["divisionId"]:
                fail("H02", "Cross-division assignment", jobId=jid)
            if job["requiredSkill"] not in worker["skills"]:
                fail("H03", "Required skill missing", jobId=jid)
            if job.get("requiredHdTypes") and not set(job["requiredHdTypes"]) <= set(worker.get("supportedHdTypes", {}).get(job.get("bkType"), [])):
                fail("H03", "Required HD types missing within the job BK", jobId=jid)
            if job.get("requiredTransportMode") and job["requiredTransportMode"] != worker["transportMode"]:
                fail("H04", "Transport mismatch", jobId=jid)
            start, finish = visit.get("start"), visit.get("finish")
            if not isinstance(start, int) or not isinstance(finish, int):
                fail("H05", "Noninteger or absent visit times", jobId=jid)
                continue
            if not max(job["windowStart"], job["releaseTime"]) <= start <= job["windowEnd"]:
                fail("H05", "Service starts outside window/release", jobId=jid)
            if finish != start + job["serviceDuration"]:
                fail("H06", "Incorrect service duration", jobId=jid)
            if start < worker["shiftStart"] or finish > worker["shiftEnd"]:
                fail("H06", "Service outside worker shift", jobId=jid)
            if event is not None and start < event:
                fail("H11", "New service before event", jobId=jid)
            if any(start < old_finish and old_start < finish for old_start, old_finish in prior_intervals):
                fail("H07", "Overlapping services", jobId=jid)
            prior_intervals.append((start, finish))
            travel = problem["travelTimeMatrices"].get(worker["transportMode"], {}).get(node, {}).get(job["locationId"])
            distance = problem["distanceMatrices"].get(worker["transportMode"], {}).get(node, {}).get(job["locationId"])
            if travel is None or distance is None:
                fail("H08", "Unavailable or missing road arc", jobId=jid, origin=node)
            elif start < previous_finish + travel:
                fail("H08", "Insufficient travel time", jobId=jid, earliestArrival=previous_finish + travel)
            if not set(job.get("requiredQualifications", [])) <= set(worker.get("qualifications", [])) or not set(job.get("requiredEquipment", [])) <= set(worker.get("equipment", [])):
                fail("H12", "Required resources absent", jobId=jid)
            node, previous_finish = job["locationId"], finish
    unassigned = solution.get("unassigned", [])
    unassigned_ids = [u if isinstance(u, str) else u["jobId"] for u in unassigned]
    if len(unassigned_ids) != len(set(unassigned_ids)):
        fail("H01", "Duplicate unassigned records")
    if set(assigned) & set(unassigned_ids) or set(assigned) | set(unassigned_ids) != set(jobs):
        fail("H01", "Assigned and unassigned do not partition the original job set")
    for activity in problem.get("fixedActivities", []) + problem.get("protectedActivities", []):
        actual = assigned.get(activity["jobId"])
        if actual is None or any(actual.get(k) != activity[k] for k in ["workerId", "start", "finish"]):
            fail("H10", "Protected visit changed or removed", jobId=activity["jobId"])
    # Completed history is carried as immutable data, separate from remaining-day routes.
    if problem.get("eventAt") is not None:
        expected_past = problem.get("pastActivities", [])
        if solution.get("pastActivities", []) != expected_past:
            fail("H11", "Past activities changed")
    return {"totalHardViolations": sum(counts.values()), **counts, "violations": violations,
            "validationTimeMs": (time.perf_counter() - began) * 1000}
