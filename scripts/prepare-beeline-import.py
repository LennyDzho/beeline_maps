"""Build the application import preview without writing to any application database.

Reuses the audited source reconstruction, but gives application entities their
own IDs and retains the completed job excluded from the optimization benchmark.
No network requests and no modifications to source/research files.
"""
import argparse
import hashlib
import importlib.util
import json
import re
import xml.etree.ElementTree as ET
import zipfile
from collections import Counter, defaultdict
from datetime import datetime, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RESEARCH = ROOT / "algorithm-research"
VERSION = "beeline-app-v1"
OUTPUT = ROOT / "apps/web/data/beeline-import.json"


def require(condition, message):
    if not condition:
        raise ValueError(message)


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def read_json(path):
    return json.loads(path.read_text(encoding="utf-8"))


def entity_id(division, kind, name):
    return f"{VERSION}-{division}-{kind}-{hashlib.sha256(name.encode()).hexdigest()[:12]}"


def normalize_hd(name):
    # Slashes in TVE/ENT and Гбит/с are part of a single name.
    if name == "Заказ подключения/Дозаказ оборудования":
        return ["Заявка на подключение", "Дозаказ оборудования"]
    return ["Заявка на подключение" if name == "Заказ подключения" else name]


def read_normatives(path):
    ns = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
    with zipfile.ZipFile(path) as archive:
        strings = ["".join(item.itertext()) for item in ET.fromstring(archive.read("xl/sharedStrings.xml")).findall("m:si", ns)]
        xml = ET.fromstring(archive.read("xl/worksheets/sheet1.xml"))
        cells = {}
        for cell in xml.findall(".//m:c", ns):
            value = cell.find("m:v", ns)
            if value is not None:
                cells[cell.get("r")] = strings[int(value.text)] if cell.get("t") == "s" else value.text
        mapping = {"Подключение": 2, "Глобальная проблема": 3, "Дозаказ": 4, "Локальная заявка": 5}
        result = {}
        for bk, row in mapping.items():
            road, work, documents, total = [int(cells[f"{column}{row}"]) for column in "BCDE"]
            require(road + work + documents == total, f"Normative total changed: row {row}")
            result[bk] = {"label": cells[f"A{row}"], "roadMinutes": road, "workMinutes": work,
                          "documentsMinutes": documents, "sourceTotalMinutes": total,
                          "serviceMinutes": work + documents, "range": f"A{row}:E{row}",
                          "durationSource": f"Нормативы.xlsx, C{row}+D{row}; соответствие ВК — настройка сценария (Q-044). Без дороги."}
        return result


def build(source_dir=None):
    spec = importlib.util.spec_from_file_location("source_dataset", RESEARCH / "scripts/build_dataset.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    source, statistics = module.build()  # Read-only reconstruction and row/hash checks.
    audited = read_json(RESEARCH / "datasets/beeline-hd-v2/dataset.json")
    require({j["id"] for j in source["jobs"]} == {j["id"] for j in audited["jobs"]}, "HD research has a different source set")
    sources = read_json(RESEARCH / "datasets/beeline-v1/source-manifest.json")
    if source_dir:
        for item in sources["files"]:
            require(sha(Path(source_dir) / item["file"]) == item["sha256"], f"Original differs from audited source: {item['file']}")
    norm_path = ROOT / "Нормативы.xlsx"
    norms = read_normatives(norm_path)
    geo_path = RESEARCH / "benchmark/datasets/geocoded-problem.json"
    geography = read_json(geo_path)["geocodingProvenance"]
    worker_ids = {w["id"]: entity_id(w["divisionId"], "worker", w["name"]) for w in source["workers"]}
    divisions, workers, jobs, categories, types = [], [], [], [], []
    warnings = [
        "Смена 09:00–22:00, автомобиль и отсутствие перерыва — изменяемые тестовые настройки, этих полей нет в CSV.",
        "Норматив = технические работы + документы. Фиксированные 20 минут дороги заменяются временем картографического сервиса; соответствие ВК нормативам — настройка Q-044.",
        "Перечень оборудования, телефоны, подъезды и домофоны в исходниках отсутствуют и оставлены незаполненными.",
        "Плановое начало для новых неназначенных заявок — временное значение по началу окна. Оно заменяется при распределении; фактическое время выполненной заявки неизвестно.",
    ]
    points = []
    for division in source["divisions"]:
        did = division["id"]
        office = geography[f"office:{did}"]
        require(office["sourceAddress"] == division["office"]["address"], f"Office address changed: {did}")
        divisions.append({"id": f"{VERSION}-{did}", "sourceId": did, "name": division["name"],
                          "timezone": "Europe/Moscow", "officeAddress": division["office"]["address"],
                          "officeCoordinates": office["point"], "officeProvenance": office,
                          "schedule": {"start": "09:00", "end": "22:00", "break": None, "isAssumption": True}})
        if office.get("isAssumption"):
            points.append({"entityId": f"{VERSION}-{did}", "address": division["office"]["address"], "reason": office["reason"]})
        division_jobs = [j for j in source["jobs"] if j["divisionId"] == did]
        for bk in sorted({j["sourceBK"] for j in division_jobs}):
            categories.append({"id": entity_id(did, "bk", bk), "divisionId": f"{VERSION}-{did}", "name": bk,
                               "serviceDurationMinutes": norms[bk]["serviceMinutes"], "durationSource": norms[bk]["durationSource"]})
        hd_bks = defaultdict(set)
        for job in division_jobs:
            for hd in normalize_hd(job["sourceHD"]):
                hd_bks[hd].add(job["sourceBK"])
        for hd, bks in sorted(hd_bks.items()):
            types.append({"id": entity_id(did, "hd", hd), "divisionId": f"{VERSION}-{did}", "name": hd,
                          "categoryIds": [entity_id(did, "bk", bk) for bk in sorted(bks)],
                          # The category norm always overrides this component default.
                          "defaultDurationMinutes": max(norms[bk]["serviceMinutes"] for bk in bks),
                          "durationSource": "Норматив ВК; для нескольких ВК при создании заявки применяется норматив выбранного ВК.",
                          "equipment": [], "equipmentKnown": False})
    audited_workers = {w["id"]: w for w in audited["workers"]}
    audited_jobs = {j["id"]: j for j in audited["jobs"]}
    for worker in source["workers"]:
        did = worker["divisionId"]
        evidence = defaultdict(list)
        for observed in worker["observedWorkTypes"]:
            for hd in normalize_hd(observed["sourceHD"]):
                evidence[(observed["sourceBK"], hd)].extend(observed["jobIds"])
        actual = {(bk, hd) for bk, names in audited_workers[worker["id"]]["supportedHdTypes"].items() for hd in names}
        require(set(evidence) == actual, f"HD competencies differ from source: {worker['id']}")
        workers.append({"id": worker_ids[worker["id"]], "sourceId": worker["id"], "divisionId": f"{VERSION}-{did}",
                        "name": worker["name"], "timezone": "Europe/Moscow", "transportMode": "car", "phone": "",
                        "startAddress": "", "startCoordinates": None,
                        "competencies": [{"categoryId": entity_id(did, "bk", bk), "workTypeId": entity_id(did, "hd", hd),
                                          "evidenceJobIds": ids} for (bk, hd), ids in sorted(evidence.items())]})
    for job in source["jobs"]:
        did, bk = job["divisionId"], job["sourceBK"]
        hd = normalize_hd(job["sourceHD"])
        require(hd == audited_jobs[job["id"]]["requiredHdTypes"], f"HD composition differs: {job['id']}")
        jid = f"{VERSION}-{did}-job-{job['source']['syntheticId']}"
        emergency = "Авария" in hd
        start, end = job["windowStart"][:16], job["windowEnd"][:16]
        if emergency:
            start = start[:10] + "T00:00"
            end = (datetime.fromisoformat(start) + timedelta(days=1)).isoformat(timespec="minutes")
        point = geography.get(job["id"])
        if point:
            require(point["sourceAddress"] == job["buildingAddress"], f"Geocoding source changed: {jid}")
        # The retained completed visit is absent from the benchmark; do not invent its coordinate.
        apartment = re.search(r",\s*кв\.\s*(.+)$", job["fullAddress"])
        jobs.append({"id": jid, "divisionId": f"{VERSION}-{did}", "number": job["source"]["syntheticId"],
                     "categoryId": entity_id(did, "bk", bk), "categoryName": bk, "workNames": hd,
                     "workTypeIds": [entity_id(did, "hd", name) for name in hd],
                     "status": job["status"], "assigneeId": worker_ids.get(job["assignedWorkerId"]),
                     "priority": "high" if emergency else "medium", "isEmergency": emergency,
                     "timezone": "Europe/Moscow", "clientWindowStart": start, "clientWindowEnd": end,
                     "buildingAddress": job["buildingAddress"], "address": job["fullAddress"],
                     "apartment": apartment.group(1).strip() if apartment else "", "entrance": "", "intercom": "",
                     "district": job["district"], "coordinates": point["point"] if point else None,
                     "geocodingProvenance": point, "serviceDurationMinutes": norms[bk]["serviceMinutes"],
                     "durationSource": norms[bk]["durationSource"], "source": job["source"],
                     "historicalAssignment": job["historicalAssignment"], "connectionType": job["connectionType"],
                     "gigabitConnection": job["gigabitConnection"]})
        if point and point.get("isAssumption"):
            points.append({"entityId": jid, "address": job["buildingAddress"], "reason": point["reason"]})
    for job in jobs:
        required = {(job["categoryId"], tid) for tid in job["workTypeIds"]}
        eligible = [w for w in workers if w["divisionId"] == job["divisionId"]
                    and required <= {(c["categoryId"], c["workTypeId"]) for c in w["competencies"]}]
        require(eligible, f"No eligible worker: {job['id']}")
        require(job["status"] != "new" or job["assigneeId"] is None, "Historical assignment leaked into queue")
    counts = {"divisions": len(divisions), "workers": len(workers), "jobs": len(jobs),
              "newJobs": sum(j["status"] == "new" for j in jobs), "completedJobs": sum(j["status"] == "completed" for j in jobs),
              "excludedDuplicates": len(source["excludedJobs"]), "compositeJobs": sum(len(j["workTypeIds"]) > 1 for j in jobs),
              "competencies": sum(len(w["competencies"]) for w in workers), "assumedCoordinates": len(points)}
    require((counts["jobs"], counts["newJobs"], counts["completedJobs"], counts["workers"]) == (204, 203, 1, 35), "Counts differ")
    manifest = {"schemaVersion": 1, "datasetVersion": VERSION, "serviceDate": source["metadata"]["date"],
                "sourceFiles": sources["files"] + [{"file": norm_path.name, "sha256": sha(norm_path)}],
                "researchInputs": [{"file": "beeline-hd-v2/dataset.json", "sha256": sha(RESEARCH / "datasets/beeline-hd-v2/dataset.json")},
                                   {"file": "geocoded-problem.json", "sha256": sha(geo_path)}],
                "normatives": norms, "counts": counts, "warnings": warnings, "assumedCoordinates": points,
                "divisions": divisions, "categories": categories, "workTypes": types, "workers": workers, "jobs": jobs,
                "excludedJobs": source["excludedJobs"], "sourceChecks": statistics["checks"]}
    canonical = json.dumps(manifest, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
    manifest["contentHash"] = hashlib.sha256(canonical).hexdigest()
    return manifest


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--verify-originals", type=Path, help="Also compare six original CSVs in this directory")
    parser.add_argument("--check", action="store_true", help="Compare the prepared artifact without rewriting it")
    args = parser.parse_args()
    manifest = build(args.verify_originals)
    content = json.dumps(manifest, ensure_ascii=False, indent=2) + "\n"
    if args.check:
        require(OUTPUT.read_text(encoding="utf-8") == content, "Prepared application manifest is stale")
    else:
        OUTPUT.parent.mkdir(parents=True, exist_ok=True)
        OUTPUT.write_text(content, encoding="utf-8", newline="\n")
    print(json.dumps({"output": str(OUTPUT), "counts": manifest["counts"], "contentHash": manifest["contentHash"]}, ensure_ascii=False))
