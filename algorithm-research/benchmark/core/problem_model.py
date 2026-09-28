"""Versioned JSON contract. All times are integer seconds since local midnight."""

import hashlib
import json


def fingerprint(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def seconds(clock):
    hour, minute = map(int, clock.split(":"))
    if not (0 <= hour <= 23 and 0 <= minute <= 59):
        raise ValueError(f"Invalid local time: {clock}")
    return hour * 3600 + minute * 60


def prepare_problem(dataset, config):
    """Normalise approved fields without fabricating coordinates or road arcs."""
    shift = config["shift"]
    workers = []
    for w in dataset["workers"]:
        workers.append({
            "id": w["id"], "name": w["name"], "divisionId": w["divisionId"],
            "skills": w["qualificationIds"], "transportMode": config["transportMode"],
            "shiftStart": seconds(shift["start"]), "shiftEnd": seconds(shift["end"]),
            "breaks": shift["breaks"], "startLocationId": "office:" + w["divisionId"],
            "startAddress": w["startLocation"]["address"],
            "startCoordinates": w["startLocation"]["coordinates"],
            "availableAt": seconds(shift["start"]), "qualifications": [], "equipment": [],
        })
    jobs = []
    for j in dataset["jobs"]:
        if j["status"] != "new":
            continue
        emergency = j["sourceHD"] in config["emergencyHDTypes"]
        jobs.append({
            "id": j["id"], "divisionId": j["divisionId"], "locationId": j["id"],
            "address": j["buildingAddress"], "coordinates": None,
            "requiredSkill": j["requiredQualificationId"], "requiredTransportMode": None,
            "serviceDuration": config["serviceMinutesByBK"][j["sourceBK"]] * 60,
            "windowStart": 0 if emergency else seconds(j["windowStart"][11:16]),
            "windowEnd": 86399 if emergency else seconds(j["windowEnd"][11:16]),
            "releaseTime": seconds(config["initialReleaseTime"]),
            "isEmergency": emergency, "priority": "urgent" if emergency else "normal",
            "requiredQualifications": [], "requiredEquipment": [],
            "source": j["source"], "sourceBK": j["sourceBK"], "sourceHD": j["sourceHD"],
        })
    return {
        "schemaVersion": 1, "id": config["experimentId"],
        "date": dataset["metadata"]["date"], "timezone": "Europe/Moscow",
        "datasetVersion": fingerprint(dataset), "configurationVersion": fingerprint(config),
        "workers": workers, "jobs": jobs, "travelTimeMatrices": {}, "distanceMatrices": {},
        "matrixVersion": None, "matrixPreparationTimeMs": None,
        "fixedActivities": [], "protectedActivities": [], "previousSolution": None,
        "eventAt": None, "resourceRules": config["resources"],
        "returnToStart": False,
    }
