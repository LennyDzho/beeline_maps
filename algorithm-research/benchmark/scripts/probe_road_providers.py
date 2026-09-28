"""Read-only cached checks of 2GIS routing and OSM address features."""
import argparse
import json
import sys
import urllib.parse
import urllib.request
from pathlib import Path

from prepare_geodata import key_from_file, request_json, save

ROOT = Path(__file__).resolve().parents[1]
sys.stdout.reconfigure(encoding="utf-8")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--provider", choices=["2gis", "osm"], required=True)
    parser.add_argument("--credential-file")
    args = parser.parse_args()
    path = ROOT / f"matrices/{args.provider}-routing-address-probe.json"
    if path.exists():
        print(path.read_text(encoding="utf-8"))
        return
    if args.provider == "2gis":
        key = key_from_file(args.credential_file)
        response = request_json("https://routing.api.2gis.com/get_dist_matrix", key, {"version": "2.0"},
            {"points": [{"lat": 55.7355002, "lon": 37.676817}, {"lat": 55.7311522, "lon": 37.7534715}],
             "sources": [0, 1], "targets": [0, 1], "transport": "driving", "type": "shortest"})
    else:
        points = [(55.702293, 37.77392), (55.602278, 37.665589), (54.840976, 38.239527),
                  (54.840664, 38.242023), (54.840831, 38.242986), (55.719742, 37.637204)]
        query = '[out:json][timeout:40];(' + ''.join(
            f'nwr(around:180,{lat},{lon})["addr:housenumber"];' for lat, lon in points) + ');out center tags;'
        req = urllib.request.Request("https://overpass-api.de/api/interpreter", data=urllib.parse.urlencode({"data": query}).encode(),
            headers={"User-Agent": "MMI-Algorithm-Research/1.0 (one-time address quality review)"})
        with urllib.request.urlopen(req, timeout=55) as res:
            response = json.load(res)
    save(path, response)
    print(json.dumps(response, ensure_ascii=False))


if __name__ == "__main__":
    main()
