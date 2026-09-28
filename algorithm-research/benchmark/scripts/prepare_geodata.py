"""Fetch an independent 2GIS snapshot. Credentials are never copied or logged."""

import argparse
import hashlib
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from core.problem_model import fingerprint, prepare_problem


def save(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def key_from_file(path):
    for line in Path(path).read_text(encoding="utf-8").splitlines():
        if line.startswith("TWO_GIS_API_KEY="):
            return line.split("=", 1)[1].strip().strip("\"'")
    raise ValueError("No TWO_GIS_API_KEY in the supplied configuration")


def request_json(endpoint, key, query=None, body=None):
    url = endpoint + "?" + urllib.parse.urlencode({**(query or {}), "key": key})
    request = urllib.request.Request(url, headers={"Content-Type": "application/json", "Accept": "application/json"},
                                     data=json.dumps(body).encode() if body is not None else None)
    try:
        with urllib.request.urlopen(request, timeout=35) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        # Do not stringify errors: their URL contains the API credential.
        raise RuntimeError(f"Provider HTTP {error.code}") from None
    except (urllib.error.URLError, TimeoutError):
        raise RuntimeError("Provider connection failed or timed out") from None


def house(address):
    address = address.split(" / ")[0]
    match = re.search(r"(?:^|[,\s])д(?:ом)?\.?\s*([\dк][^,]*)", address.lower())
    value = (match.group(1) if match else address.rsplit(",", 1)[-1]).strip()
    value = value.replace("корпус", "к").replace("строение", "с").replace("корп", "к").replace("стр", "с").replace("ст", "с").removeprefix("вл")
    return re.sub(r"[\s.\-]", "", value.lower())


def street_tokens(address):
    address = address.lower().replace("ё", "е").split(" / ")[0]
    address = re.sub(r"пгт\.[^,]+,", "", address)
    address = re.split(r"(?:^|[,\s])д(?:ом)?\.?\s*[\dк]", address)[0]
    address = re.sub(r",\s*(?:вл)?\d[^,]*$", "", address)
    for pattern, replacement in [
        (r"\bул(?:\.|\b)", "улица "), (r"\bпер(?:\.|\b)", "переулок "),
        (r"б-р(?:\.|\b)", "бульвар "), (r"пр-кт(?:\.|\b)", "проспект "), (r"\bнаб(?:\.|\b)", "набережная "),
        (r"\bш(?:\.|\b)", "шоссе "), (r"пр-зд(?:\.|\b)", "проезд "),
    ]:
        # Only abbreviations; do not rewrite the beginning of a full word.
        address = re.sub(pattern, replacement, address)
    tokens = re.findall(r"[а-я0-9]+", address)
    return set(tokens) - {"г", "город", "мо", "московская", "область", "обл"}


def select_candidate(address, candidates):
    source_tokens = street_tokens(address)
    matches = []
    for item in candidates:
        target = item.get("full_name") or item.get("address_name") or ""
        target_address = item.get("address_name") or target
        if (item["type"] == "building" and item.get("point")
                and house(address) == house(target_address)
                and source_tokens <= (street_tokens(target) | street_tokens(target_address))):
            matches.append(item)
    exact_buildings = [item for item in matches if not re.search(r",\s*вл", item.get("address_name") or "", re.I)]
    if exact_buildings:
        matches = exact_buildings
    unique = {tuple(sorted(item["point"].items())) for item in matches}
    return matches[0] if len(unique) == 1 else None


def geocode(address, key):
    started = time.perf_counter()
    response = request_json("https://catalog.api.2gis.com/3.0/items/geocode", key,
                            {"q": address, "fields": "items.point", "page_size": 5})
    if response.get("meta", {}).get("code") != 200:
        raise RuntimeError("Geocoder response code was not 200")
    candidates = [{k: item.get(k) for k in ["id", "type", "name", "address_name", "full_name", "point"]}
                  for item in response.get("result", {}).get("items", [])]
    selected = select_candidate(address, candidates)
    return {"query": address, "retrievedAt": datetime.now(timezone.utc).isoformat(),
            "provider": "2gis", "elapsedMs": (time.perf_counter() - started) * 1000,
            "status": "MATCHED_BUILDING" if selected else "NEEDS_REVIEW",
            "selectionRule": "unique_building_with_matching_house_city_and_street",
            "selected": selected, "candidates": candidates}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--credential-file", required=True)
    parser.add_argument("--probe", action="store_true")
    parser.add_argument("--geocode-only", action="store_true")
    args = parser.parse_args()
    key = os.environ.get("TWO_GIS_API_KEY") or key_from_file(args.credential_file)
    config = json.loads((ROOT / "requirements/experiment.json").read_text(encoding="utf-8"))
    source = json.loads((ROOT.parent / "datasets/beeline-v1/dataset.json").read_text(encoding="utf-8"))
    problem = prepare_problem(source, config)
    if args.probe:
        address = problem["workers"][0]["startAddress"]
        result = geocode(address, key)
        save(ROOT / "matrices/geocoder-probe.json", result)
        print(json.dumps(result, ensure_ascii=False))
        return
    addresses = {w["startLocationId"]: w["startAddress"] for w in problem["workers"]}
    addresses.update({j["locationId"]: j["address"] for j in problem["jobs"]})
    cache_path = ROOT / "matrices/geocoding.json"
    cache = json.loads(cache_path.read_text(encoding="utf-8")) if cache_path.exists() else {}
    for index, address in enumerate(dict.fromkeys(addresses.values()), 1):
        if address not in cache:
            cache[address] = geocode(address, key)
            save(cache_path, cache)
            time.sleep(0.12)
        else:
            cache[address]["selected"] = select_candidate(address, cache[address]["candidates"])
            cache[address]["status"] = "MATCHED_BUILDING" if cache[address]["selected"] else "NEEDS_REVIEW"
            cache[address]["selectionRule"] = "unique_building_with_matching_house_city_and_street"
        print(f"Geocoding {index}/{len(set(addresses.values()))}: {cache[address]['status']}", flush=True)
    save(cache_path, cache)
    unresolved = {lid: address for lid, address in addresses.items() if not cache[address].get("selected")}
    save(ROOT / "matrices/unresolved-addresses.json", unresolved)
    if unresolved:
        print(f"BLOCKED_DATA: {len(unresolved)} locations require geocoding review")
        return
    points = {lid: cache[address]["selected"]["point"] for lid, address in addresses.items()}
    for worker in problem["workers"]:
        worker["startCoordinates"] = points[worker["startLocationId"]]
    for job in problem["jobs"]:
        job["coordinates"] = points[job["locationId"]]
    if args.geocode_only:
        save(ROOT / "datasets/geocoded-problem.json", problem)
        return
    started = time.perf_counter()
    times, distances = {}, {}
    for division in sorted({w["divisionId"] for w in problem["workers"]}):
        nodes = sorted({w["startLocationId"] for w in problem["workers"] if w["divisionId"] == division}
                       | {j["locationId"] for j in problem["jobs"] if j["divisionId"] == division})
        for i in range(0, len(nodes), 10):
            for j in range(0, len(nodes), 10):
                origins, destinations = nodes[i:i+10], nodes[j:j+10]
                block_nodes = list(dict.fromkeys(origins + destinations))
                payload = {"points": [points[n] for n in block_nodes],
                           "sources": [block_nodes.index(n) for n in origins],
                           "targets": [block_nodes.index(n) for n in destinations],
                           "transport": "driving", "type": "shortest"}
                # Static traffic-free snapshot; all solvers share these exact directed arcs.
                digest = fingerprint(payload)
                block_path = ROOT / f"matrices/blocks/{digest}.json"
                if block_path.exists():
                    block = json.loads(block_path.read_text(encoding="utf-8"))
                else:
                    block = request_json("https://routing.api.2gis.com/get_dist_matrix", key, {"version": "2.0"}, payload)
                    save(block_path, block)
                    time.sleep(0.12)
                for arc in block.get("routes", []):
                    a, b = block_nodes[arc["source_id"]], block_nodes[arc["target_id"]]
                    valid = arc.get("status") == "OK"
                    times.setdefault(a, {})[b] = int(arc["duration"]) if valid else None
                    distances.setdefault(a, {})[b] = int(arc["distance"]) if valid else None
                for n in set(origins) & set(destinations):
                    times.setdefault(n, {})[n] = distances.setdefault(n, {})[n] = 0
                print(f"Matrix {division}: {i+1},{j+1} / {len(nodes)}", flush=True)
    problem["travelTimeMatrices"] = {"car": times}
    problem["distanceMatrices"] = {"car": distances}
    problem["matrixVersion"] = fingerprint({"times": times, "distances": distances})
    problem["matrixPreparationTimeMs"] = (time.perf_counter() - started) * 1000
    problem["matrixProvenance"] = {"provider": "2gis", "transport": "driving", "type": "shortest", "traffic": "none", "units": "seconds/metres"}
    save(ROOT / "datasets/problem.json", problem)
    from core.preflight import require_ready
    print(json.dumps(require_ready(problem), ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except RuntimeError as exc:
        print(str(exc), file=sys.stderr)
        sys.exit(1)
