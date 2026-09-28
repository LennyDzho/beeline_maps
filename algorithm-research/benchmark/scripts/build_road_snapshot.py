"""Freeze one complete road provider snapshot; 2GIS first, OSM/OSRM fallback.

No straight-line substitution. Geocoding decisions live in a separate review file.
If 2GIS fails, rebuild the entire matrix with OSRM rather than mixing arc providers.
"""
import argparse
import json
import math
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
from core.preflight import require_ready
from prepare_geodata import key_from_file, request_json, save

sys.stdout.reconfigure(encoding="utf-8")


def read(path):
    return json.loads(path.read_text(encoding="utf-8"))


def geocoded_problem(allow_assumptions=False):
    config = read(ROOT / "requirements/experiment.json")
    problem = prepare_problem(read(ROOT.parent / "datasets/beeline-v1/dataset.json"), config)
    cache = read(ROOT / "matrices/geocoding.json")
    decisions = read(ROOT / "matrices/geocoding-resolutions.json")
    addresses = {w["startLocationId"]: w["startAddress"] for w in problem["workers"]}
    addresses.update({j["locationId"]: j["address"] for j in problem["jobs"]})
    points, provenance, unresolved = {}, {}, {}
    for lid, address in addresses.items():
        if address in decisions:
            decision = decisions[address]
            if decision["isAssumption"] and not allow_assumptions:
                unresolved[lid] = address
                continue
            points[lid] = decision["point"]
            provenance[lid] = decision
        elif cache[address].get("selected"):
            selected = cache[address]["selected"]
            points[lid] = selected["point"]
            provenance[lid] = {"provider": "2gis", "isAssumption": False, "sourceAddress": address,
                "matchedAddress": selected["full_name"] or selected["address_name"], "providerId": selected["id"], "point": selected["point"]}
        else:
            unresolved[lid] = address
    save(ROOT / "matrices/unresolved-after-osm.json", unresolved)
    if unresolved:
        raise RuntimeError(f"BLOCKED_DATA: {len(unresolved)} locations need an explicit geocoding scenario")
    for worker in problem["workers"]:
        worker["startCoordinates"] = points[worker["startLocationId"]]
    for job in problem["jobs"]:
        job["coordinates"] = points[job["locationId"]]
    problem["geocodingVersion"] = fingerprint(provenance)
    problem["geocodingProvenance"] = provenance
    problem["geocodingAssumptions"] = [lid for lid, decision in provenance.items() if decision["isAssumption"]]
    if problem["geocodingAssumptions"]:
        problem["id"] += "-declared-geography"
    return problem, points


def nodes_by_division(problem):
    for division in sorted({w["divisionId"] for w in problem["workers"]}):
        yield division, sorted({w["startLocationId"] for w in problem["workers"] if w["divisionId"] == division}
            | {j["locationId"] for j in problem["jobs"] if j["divisionId"] == division})


def fetch_2gis(problem, points, key):
    times, distances = {}, {}
    for division, nodes in nodes_by_division(problem):
        for i in range(0, len(nodes), 10):
            for j in range(0, len(nodes), 10):
                origins, targets = nodes[i:i+10], nodes[j:j+10]
                block_nodes = list(dict.fromkeys(origins + targets))
                payload = {"points": [points[n] for n in block_nodes], "sources": [block_nodes.index(n) for n in origins],
                    "targets": [block_nodes.index(n) for n in targets], "transport": "driving", "type": "shortest"}
                path = ROOT / f"matrices/2gis-blocks/{fingerprint(payload)}.json"
                if path.exists():
                    envelope = read(path)
                else:
                    response = request_json("https://routing.api.2gis.com/get_dist_matrix", key, {"version": "2.0"}, payload)
                    envelope = {"requestedAt": datetime.now(timezone.utc).isoformat(), "request": payload, "response": response}
                    save(path, envelope)
                    time.sleep(0.15)
                response = envelope["response"]
                routes = response.get("routes", [])
                if len(routes) != len(origins)*len(targets):
                    raise RuntimeError("2GIS did not return the complete requested block")
                for arc in routes:
                    if arc["status"] != "OK":
                        # An error is not evidence that a road is unreachable.
                        raise RuntimeError("2GIS returned a non-OK route; no missing arc will be replaced by zero")
                    a, b = block_nodes[arc["source_id"]], block_nodes[arc["target_id"]]
                    valid = arc["status"] == "OK"
                    times.setdefault(a, {})[b] = math.ceil(arc["duration"]) if valid else None
                    distances.setdefault(a, {})[b] = math.ceil(arc["distance"]) if valid else None
                for n in set(origins) & set(targets):
                    times.setdefault(n, {})[n] = distances.setdefault(n, {})[n] = 0
                print(f"2GIS {division}: source block {i//10+1}, target block {j//10+1}", flush=True)
    return times, distances, {"provider": "2gis", "transport": "driving", "type": "shortest", "traffic": "none"}


def fetch_osrm(problem, points, endpoint):
    times, distances, snap = {}, {}, {}
    for division, nodes in nodes_by_division(problem):
        coordinates = ";".join(f"{points[n]['lon']},{points[n]['lat']}" for n in nodes)
        url = endpoint.rstrip("/") + "/table/v1/driving/" + coordinates + "?annotations=duration,distance"
        path = ROOT / f"matrices/osrm-blocks/{fingerprint(url)}.json"
        if path.exists():
            envelope = read(path)
        else:
            req = urllib.request.Request(url, headers={"User-Agent": "MMI-Algorithm-Research/1.0 (one-time frozen road matrix)"})
            with urllib.request.urlopen(req, timeout=55) as res:
                response = json.load(res)
            envelope = {"requestedAt": datetime.now(timezone.utc).isoformat(), "requestUrl": url, "response": response}
            save(path, envelope)
            time.sleep(1.1)
        response = envelope["response"]
        if response.get("code") != "Ok" or not all(k in response for k in ["durations", "distances", "sources"]):
            raise RuntimeError("OSRM did not return a complete road table")
        if response.get("fallback_speed_cells"):
            raise RuntimeError("Straight-line fallback cells are prohibited")
        for i, node in enumerate(nodes):
            snap[node] = response["sources"][i]
            if snap[node]["distance"] > 500:
                raise RuntimeError("OSRM snapped a point over 500 m from its input; review required")
            times[node], distances[node] = {}, {}
            for j, target in enumerate(nodes):
                t, d = response["durations"][i][j], response["distances"][i][j]
                times[node][target] = math.ceil(t) if t is not None else None
                distances[node][target] = math.ceil(d) if d is not None else None
        print(f"OSM/OSRM {division}: {len(nodes)} x {len(nodes)}", flush=True)
    save(ROOT / "matrices/osrm-snapping.json", snap)
    return times, distances, {"provider": "OSM/OSRM", "endpoint": endpoint, "transport": "driving", "type": "fastest",
        "traffic": "none", "attribution": "© OpenStreetMap contributors; ODbL", "licenseUrl": "https://www.openstreetmap.org/copyright",
        "engineVersion": "public endpoint does not expose a verifiable build; raw responses frozen"}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--credential-file")
    parser.add_argument("--provider", choices=["auto", "2gis", "osm"], default="auto")
    parser.add_argument("--allow-declared-geography", action="store_true")
    parser.add_argument("--osm-endpoint", default="https://router.project-osrm.org")
    args = parser.parse_args()
    problem, points = geocoded_problem(args.allow_declared_geography)
    save(ROOT / "datasets/geocoded-problem.json", problem)
    started = time.perf_counter()
    fallback_reason = None
    if args.provider in {"auto", "2gis"}:
        try:
            times, distances, provenance = fetch_2gis(problem, points, key_from_file(args.credential_file))
        except (RuntimeError, urllib.error.URLError) as error:
            if args.provider == "2gis":
                raise
            fallback_reason = str(error)
            save(ROOT / "matrices/provider-fallback.json", {"reason": fallback_reason, "timestamp": datetime.now(timezone.utc).isoformat()})
            print("2GIS failed: switching the complete snapshot to OSM/OSRM", flush=True)
            times, distances, provenance = fetch_osrm(problem, points, args.osm_endpoint)
    else:
        times, distances, provenance = fetch_osrm(problem, points, args.osm_endpoint)
    problem["travelTimeMatrices"], problem["distanceMatrices"] = {"car": times}, {"car": distances}
    problem["matrixVersion"] = fingerprint({"times": times, "distances": distances})
    problem["matrixPreparationTimeMs"] = (time.perf_counter() - started)*1000
    problem["matrixProvenance"] = {**provenance, "units": "seconds/metres", "fallbackReason": fallback_reason,
        "frozenAt": datetime.now(timezone.utc).isoformat(), "geocodingVersion": problem["geocodingVersion"]}
    result = require_ready(problem)
    save(ROOT / "datasets/problem.json", problem)
    print(json.dumps({**result, "provider": provenance["provider"], "geocodingAssumptions": len(problem["geocodingAssumptions"])}, ensure_ascii=False))


if __name__ == "__main__":
    main()
