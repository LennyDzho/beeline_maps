"""Reconstruct the isolated research dataset using only the Python standard library."""

import argparse
import csv
import hashlib
import io
import json
import re
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1] / "datasets" / "beeline-v1"
MOSCOW = timezone(timedelta(hours=3))


def require(condition, message):
    if not condition:
        raise ValueError(message)


def json_text(value):
    return json.dumps(value, ensure_ascii=False, indent=2) + "\n"


def read_source(filename, manifest):
    raw = (ROOT / "raw" / filename).read_bytes()
    expected = manifest[filename]
    require(len(raw) == expected["bytes"], f"Changed file size: {filename}")
    require(hashlib.sha256(raw).hexdigest() == expected["sha256"], f"Changed source: {filename}")
    reader = csv.DictReader(io.StringIO(raw.decode("cp1251")), delimiter=";")
    fields = reader.fieldnames
    require(fields and len(fields) == len(set(fields)), f"Invalid header: {filename}")
    jobs, offices = [], []
    for line, row in enumerate(reader, 2):
        require(None not in row and None not in row.values(), f"Malformed CSV: {filename}:{line}")
        if not any(value.strip() for value in row.values()):
            continue
        if row["Заявка"].strip().lower() == "адрес офиса":
            offices.append({"address": row["Тип заявки BK"], "file": filename, "row": line})
            continue
        require(row["Заявка"].isdigit() and row["Начало"].strip(), f"Unexpected row: {filename}:{line}")
        jobs.append((line, row))
    return fields, jobs, offices


def building_address(address):
    return re.sub(r",\s*кв\.\s*\d+.*$", "", address).strip()


def iso_date(value):
    dt = datetime.strptime(value, "%d.%m.%Y %H:%M").replace(tzinfo=MOSCOW)
    require(dt.date().isoformat() == "2026-08-17", f"Unexpected date: {value}")
    return dt.isoformat(timespec="minutes")


def worker_id(division_id, name):
    digest = hashlib.sha256(name.encode("utf-8")).hexdigest()[:12]
    return f"beeline-v1-{division_id}-worker-{digest}"


def build():
    rules = json.loads((ROOT / "rules.json").read_text(encoding="utf-8"))
    sources = json.loads((ROOT / "source-manifest.json").read_text(encoding="utf-8"))["files"]
    manifest = {entry["file"]: entry for entry in sources}
    required_files = {d[key] for d in rules["divisions"] for key in ("syntheticFile", "controlFile")}
    require(set(manifest) == required_files and len(sources) == 6, "Source manifest mismatch")
    qualifications = rules["qualifications"]
    qualification_ids = [q["id"] for q in qualifications]
    require(len(set(qualification_ids)) == len(qualification_ids), "Duplicate qualification ID")
    bk_map = {}
    for qualification in qualifications:
        for bk in qualification["sourceBK"]:
            require(bk not in bk_map, f"Ambiguous qualification: {bk}")
            bk_map[bk] = qualification["id"]

    duplicate = rules["confirmedDuplicate"]
    jobs, excluded, divisions, workers = [], [], [], {}
    raw_count = 0
    for division in rules["divisions"]:
        did = division["id"]
        s_fields, synthetic, offices = read_source(division["syntheticFile"], manifest)
        c_fields, control, c_offices = read_source(division["controlFile"], manifest)
        require(len(synthetic) == len(control) == division["expectedRawJobs"], f"Row count: {did}")
        require(set(s_fields) <= set(c_fields), f"Missing common fields: {did}")
        require(len(offices) == 1 and not c_offices, f"Office rows: {did}")
        require(bool(offices[0]["address"].strip()), f"Missing office address: {did}")
        divisions.append({"id": did, "name": division["name"], "office": offices[0]})
        raw_count += len(synthetic)
        for (s_line, source), (c_line, historical) in zip(synthetic, control):
            require(s_line == c_line, f"Row positions differ: {did}:{s_line}")
            for field in s_fields:
                if field == "Заявка":
                    continue
                a, b = source[field], historical[field]
                if field == "Адрес":
                    a, b = building_address(a), building_address(b)
                require(a == b, f"Source join mismatch: {did}:{s_line}:{field}")
            bk, hd = source["Тип заявки BK"], source["Тип заявки HD"]
            require(bk in bk_map and hd.strip(), f"Unmapped work type: {did}:{s_line}")
            name = historical["Бригада"]
            require(name == name.strip(), f"Worker name whitespace: {did}:{s_line}")
            wid = worker_id(did, name) if name else None
            job = {
                "id": f"beeline-v1-{did}-job-{source['Заявка']}",
                "divisionId": did,
                "sourceBK": bk,
                "sourceHD": hd,
                "requiredQualificationId": bk_map[bk],
                "status": "new",
                "assignedWorkerId": None,
                "windowStart": iso_date(source["Начало"]),
                "windowEnd": iso_date(source["Окончание"]),
                "buildingAddress": source["Адрес"],
                "fullAddress": historical["Адрес"],
                "district": source["Район"],
                "connectionType": source.get("Подключение"),
                "gigabitConnection": source["Гигабитное подключение"],
                "historicalAssignment": {
                    "workerId": wid,
                    "workerName": name or None,
                    "sourceStatus": historical["Статус BK"],
                },
                "source": {
                    "syntheticFile": division["syntheticFile"],
                    "syntheticRow": s_line,
                    "syntheticId": source["Заявка"],
                    "controlFile": division["controlFile"],
                    "controlRow": c_line,
                    "controlId": historical["Заявка"],
                    "windowStart": source["Начало"],
                    "windowEnd": source["Окончание"],
                },
            }
            require(job["windowStart"] < job["windowEnd"], f"Invalid window: {job['id']}")
            if did == duplicate["divisionId"] and historical["Заявка"] == duplicate["controlId"]:
                if source["Заявка"] == duplicate["excludedSyntheticId"]:
                    require(s_line == duplicate["excludedRow"] and historical["Статус BK"] == duplicate["excludedSourceStatus"], "Excluded duplicate changed")
                    job.update(status="excluded_duplicate", exclusionReason=duplicate["reason"])
                    excluded.append(job)
                    continue
                require(source["Заявка"] == duplicate["retainedSyntheticId"] and s_line == duplicate["retainedRow"] and historical["Статус BK"] == duplicate["retainedSourceStatus"], "Retained duplicate changed")
                require(wid is not None, "Completed job has no worker")
                job.update(status="completed", assignedWorkerId=wid)
            jobs.append(job)
            if wid:
                worker = workers.setdefault(wid, {
                    "id": wid, "divisionId": did, "name": name,
                    "startLocation": {
                        "kind": "division_office",
                        "address": offices[0]["address"],
                        "coordinates": None,
                        "source": {"file": offices[0]["file"], "row": offices[0]["row"]},
                    },
                    "qualificationIds": [], "qualificationEvidence": [],
                    "observedWorkTypes": [], "historicalJobIds": [],
                })
                require(worker["divisionId"] == did and worker["name"] == name, "Worker ID collision")
                worker["historicalJobIds"].append(job["id"])

    require(raw_count == 205 and len(jobs) == 204 and len(excluded) == 1, "Unexpected dataset size")
    require(len({j["id"] for j in jobs + excluded}) == 205, "Duplicate job IDs")
    require(len({j["source"]["syntheticId"] for j in jobs + excluded}) == 205, "Duplicate synthetic IDs")
    require(len({(j["divisionId"], j["source"]["controlId"]) for j in jobs}) == 204, "Unresolved control duplicate")
    require(Counter(j["status"] for j in jobs) == {"new": 203, "completed": 1}, "Initial statuses")
    require(len(workers) == 35, "Worker count")
    division_by_id = {d["id"]: d for d in divisions}
    for worker in workers.values():
        office = division_by_id[worker["divisionId"]]["office"]
        start = worker["startLocation"]
        require(start["kind"] == "division_office" and start["address"] == office["address"], f"Wrong worker start: {worker['id']}")
        require(start["source"] == {"file": office["file"], "row": office["row"]}, f"Wrong start source: {worker['id']}")
        require(start["coordinates"] is None, "Coordinates are not present in the source")
    job_by_id = {j["id"]: j for j in jobs}
    for worker in workers.values():
        evidence, work_types = defaultdict(list), defaultdict(list)
        for jid in worker["historicalJobIds"]:
            job = job_by_id[jid]
            evidence[job["requiredQualificationId"]].append(jid)
            work_types[(job["sourceBK"], job["sourceHD"])].append(jid)
        worker["qualificationIds"] = [qid for qid in qualification_ids if qid in evidence]
        worker["qualificationEvidence"] = [
            {"qualificationId": qid, "jobIds": evidence[qid]}
            for qid in worker["qualificationIds"]
        ]
        worker["observedWorkTypes"] = [
            {"sourceBK": bk, "sourceHD": hd, "jobIds": ids}
            for (bk, hd), ids in sorted(work_types.items())
        ]
        require(1 <= len(worker["qualificationIds"]) <= 3, f"Qualification count: {worker['id']}")

    # Check both directions: all historical jobs are covered, and no skill lacks evidence.
    for job in jobs:
        wid = job["historicalAssignment"]["workerId"]
        if wid:
            require(workers[wid]["divisionId"] == job["divisionId"], "Cross-division assignment")
            require(job["requiredQualificationId"] in workers[wid]["qualificationIds"], "Unsupported historical assignment")
        eligible = [w for w in workers.values() if w["divisionId"] == job["divisionId"] and job["requiredQualificationId"] in w["qualificationIds"]]
        require(bool(eligible), f"No qualified worker in division: {job['id']}")
        require(job["status"] != "new" or job["assignedWorkerId"] is None, "Historical assignment leaked into new plan")
    for worker in workers.values():
        expected = {bk_map[job_by_id[jid]["sourceBK"]] for jid in worker["historicalJobIds"]}
        require(set(worker["qualificationIds"]) == expected, "Unsupported extra qualification")

    unassigned = [j for j in jobs if j["historicalAssignment"]["workerId"] is None]
    require([(j["divisionId"], j["source"]["controlRow"]) for j in unassigned] == [("east", 2), ("east", 33)], "Unexpected unassigned rows")
    kaushnyan = [w for w in workers.values() if w["name"] == "Бригада Каушнян"]
    require(len(kaushnyan) == 2 and len({w["divisionId"] for w in kaushnyan}) == 2, "Homonymous workers merged")
    require({w["divisionId"]: set(w["qualificationIds"]) for w in kaushnyan} == {"east": {"connection", "emergency"}, "southeast": {"connection"}}, "Homonymous worker skills mixed")

    ordered_workers = [w for d in divisions for w in sorted(workers.values(), key=lambda w: w["name"]) if w["divisionId"] == d["id"]]
    division_summary = []
    for division, spec in zip(divisions, rules["divisions"]):
        dw = [w for w in ordered_workers if w["divisionId"] == division["id"]]
        dj = [j for j in jobs if j["divisionId"] == division["id"]]
        require(len(dw) == spec["expectedWorkers"], f"Division worker count: {division['id']}")
        division_summary.append({
            "divisionId": division["id"], "name": division["name"],
            "rawJobs": spec["expectedRawJobs"], "jobs": len(dj),
            "initialPlanningJobs": sum(j["status"] == "new" for j in dj),
            "workers": len(dw),
            "startAddress": division["office"]["address"],
            "workersWithStartLocation": sum(bool(w["startLocation"]["address"]) for w in dw),
            "qualifiedWorkers": {qid: sum(qid in w["qualificationIds"] for w in dw) for qid in qualification_ids},
        })
    stats = {
        "rawJobs": raw_count, "jobs": len(jobs), "excludedDuplicates": len(excluded),
        "initialPlanningJobs": 203, "completedJobs": 1, "workers": len(workers),
        "workersWithStartLocation": sum(bool(w["startLocation"]["address"]) for w in ordered_workers),
        "distinctStartAddresses": len({w["startLocation"]["address"] for w in ordered_workers}),
        "qualificationAssignments": sum(len(w["qualificationIds"]) for w in ordered_workers),
        "workersByQualificationCount": dict(sorted(Counter(str(len(w["qualificationIds"])) for w in ordered_workers).items())),
        "qualifiedWorkers": {qid: sum(qid in w["qualificationIds"] for w in ordered_workers) for qid in qualification_ids},
        "historicallyAssignedJobs": len(jobs) - len(unassigned),
        "historicallyUnassignedJobIds": [j["id"] for j in unassigned],
        "distinctHDTypes": len({j["sourceHD"] for j in jobs}),
        "divisions": division_summary,
        "checks": {
            name: "passed" for name in [
                "source_hashes", "row_pairing_and_common_fields", "confirmed_duplicate",
                "unique_job_ids", "worker_identity_by_division", "all_bk_categories_mapped",
                "all_historical_assignments_compatible", "no_unsupported_qualifications",
                "every_job_has_qualified_worker_in_own_division", "new_jobs_unassigned",
                "all_workers_start_at_own_division_office", "worker_start_source_rows",
            ]
        },
    }
    dataset = {
        "schemaVersion": 1,
        "metadata": {
            "datasetId": "beeline-v1", "date": "2026-08-17", "timezone": "Europe/Moscow",
            "qualificationMethod": "union_of_qualifications_from_retained_historical_assignments",
            "qualificationEvidenceStatuses": "all_assigned_statuses_including_cancelled",
            "startLocationMethod": "division_office_address_from_source_footer",
            "sourceManifest": "source-manifest.json", "rules": "rules.json",
            "unmodeledFields": ["shift", "transportMode", "coordinates", "travelMatrix", "serviceDuration"],
        },
        "qualifications": qualifications, "divisions": divisions,
        "workers": ordered_workers, "jobs": jobs, "excludedJobs": excluded,
    }
    return dataset, stats


def workers_report(dataset, stats):
    names = {q["id"]: q["name"] for q in dataset["qualifications"]}
    lines = [
        "# Квалификации и точки старта исполнителей", "",
        f"Для {stats['workers']} исполнителей сформировано {stats['qualificationAssignments']} назначения квалификаций.", "",
        "Числа в таблице — количество назначенных в контроле заявок, послуживших основанием квалификации. «—» означает, что такой квалификации не добавлено.", "",
        "Три группы: Л — локальные работы, П — подключения и дозаказы, А — аварийные работы. Все статусы назначений учитываются. Подтверждённый дубль исключён.", "",
        "| Подразделение | Исполнителей | Л | П | А |",
        "|---|---:|---:|---:|---:|",
    ]
    for d in stats["divisions"]:
        q = d["qualifiedWorkers"]
        lines.append(f"| {d['name']} | {d['workers']} | {q['local']} | {q['connection']} | {q['emergency']} |")
    lines += ["", "Один навык: " + str(stats["workersByQualificationCount"].get("1", 0)) + "; два: " + str(stats["workersByQualificationCount"].get("2", 0)) + "; три: " + str(stats["workersByQualificationCount"].get("3", 0)) + ".", ""]
    for division in dataset["divisions"]:
        workers = [w for w in dataset["workers"] if w["divisionId"] == division["id"]]
        office = division["office"]
        lines += [
            f"## {division['name']}", "",
            f"Точка старта всех {len(workers)} исполнителей: **{office['address']}**.", "",
            f"Источник: «{office['file']}», строка {office['row']} («Адрес офиса»). Адрес записан в `startLocation` каждого исполнителя. Координаты в исходнике отсутствуют.", "",
            "| Исполнитель | Л | П | А | Всего заявок |", "|---|---:|---:|---:|---:|",
        ]
        for worker in workers:
            counts = {e["qualificationId"]: len(e["jobIds"]) for e in worker["qualificationEvidence"]}
            values = [str(counts[qid]) if qid in counts else "—" for qid in names]
            lines.append(f"| {worker['name']} | {' | '.join(values)} | {len(worker['historicalJobIds'])} |")
        lines += ["", "### Точные виды назначенных работ", ""]
        for worker in workers:
            lines += [f"**{worker['name']}** — " + "; ".join(names[qid] for qid in worker["qualificationIds"]) + ".", ""]
            for work in worker["observedWorkTypes"]:
                lines.append(f"- {work['sourceBK']} / {work['sourceHD']} — {len(work['jobIds'])}.")
            lines.append("")
    lines += ["Ссылки на конкретные исходные строки находятся в `dataset.json`: `qualificationEvidence.jobIds` → `jobs[].source`. [Правила и ограничения](README.md).", ""]
    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="Validate and compare without writing")
    args = parser.parse_args()
    dataset, stats = build()
    outputs = {
        "dataset.json": json_text(dataset),
        "validation.json": json_text(stats),
        "WORKERS.md": workers_report(dataset, stats),
    }
    for filename, text in outputs.items():
        path = ROOT / filename
        if args.check:
            require(path.exists() and path.read_bytes() == text.encode("utf-8"), f"Stale output: {filename}; rerun build_dataset.py")
        else:
            path.write_bytes(text.encode("utf-8"))
    print(json_text({"mode": "check" if args.check else "build", **stats}))


if __name__ == "__main__":
    main()
