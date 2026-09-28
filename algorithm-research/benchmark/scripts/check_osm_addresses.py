"""One-off OSM address review; cached, single-threaded and <= 1 request/second.

Not a generic geocoding service. See https://operations.osmfoundation.org/policies/nominatim/.
Data attribution: © OpenStreetMap contributors, ODbL https://www.openstreetmap.org/copyright.
"""
import argparse
import json
import re
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.stdout.reconfigure(encoding="utf-8")


def normalized_query(address):
    value = re.sub(r"\b(?:г\.\s*)?(?:Город|город)\s+", "", address)
    value = re.sub(r"\b(?:МО,\s*|г\.\s*)", "", value)
    value = re.sub(r"\bд\.?\s*(?=\d)", "", value)
    value = re.sub(r"\bул\.", "улица ", value)
    value = re.sub(r"\bнаб\.", "набережная ", value)
    value = re.sub(r"(\d)\s*с\s*(\d)", r"\1 строение \2", value)
    value = re.sub(r"(\d)\s*к\s*(\d)", r"\1 корпус \2", value)
    return value.strip()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--query", action="append", help="Additional explicitly chosen address variant")
    args = parser.parse_args()
    addresses = list(dict.fromkeys(json.loads((ROOT / "matrices/unresolved-addresses.json").read_text(encoding="utf-8")).values()))
    if args.query:
        addresses = args.query
    path = ROOT / "matrices/osm-geocoding-review.json"
    cache = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
    for address in addresses:
        if address not in cache:
            query = normalized_query(address)
            params = {"q": query, "format": "jsonv2", "addressdetails": 1, "limit": 10,
                      "countrycodes": "ru", "accept-language": "ru", "namedetails": 1}
            request = urllib.request.Request("https://nominatim.openstreetmap.org/search?" + urllib.parse.urlencode(params),
                headers={"User-Agent": "MMI-Algorithm-Research/1.0 (one-time address quality review)", "Accept": "application/json"})
            with urllib.request.urlopen(request, timeout=35) as response:
                results = json.load(response)
            cache[address] = {"query": query, "provider": "OSM/Nominatim", "retrievedAt": datetime.now(timezone.utc).isoformat(),
                "attribution": "© OpenStreetMap contributors; ODbL", "candidates": results}
            path.write_text(json.dumps(cache, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            time.sleep(1.1)
        print(json.dumps({"source": address, "query": cache[address]["query"], "results": [
            {key: item.get(key) for key in ["osm_type", "osm_id", "lat", "lon", "display_name", "address"]}
            for item in cache[address]["candidates"]]}, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
