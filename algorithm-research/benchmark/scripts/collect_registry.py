"""Save official release references, distinct from installed/actually tested versions."""

import importlib.metadata
import json
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def api(path):
    request = urllib.request.Request("https://api.github.com/" + path,
        headers={"Accept": "application/vnd.github+json", "User-Agent": "Marsh-local-benchmark"})
    with urllib.request.urlopen(request, timeout=25) as response:
        return json.load(response)


def main():
    candidates = json.loads((ROOT / "registry/candidates.json").read_text(encoding="utf-8"))
    records, cache = [], {}
    for candidate in candidates:
        record = dict(candidate, checkedAt=datetime.now(timezone.utc).isoformat(),
                      installedPackageVersion=None, verifiedSolverVersion=None,
                      releaseTag=None, commitSha=None, smokeTestStatus="NOT_RUN")
        if candidate["distribution"]:
            try:
                record["installedPackageVersion"] = importlib.metadata.version(candidate["distribution"])
            except importlib.metadata.PackageNotFoundError:
                pass
        repo = candidate["repository"].removeprefix("https://github.com/")
        if repo not in cache:
            try:
                release = api(f"repos/{repo}/releases/latest")
                tag = release["tag_name"]
                ref = api(f"repos/{repo}/git/ref/tags/{urllib.parse.quote(tag, safe='')}")["object"]
                commit = api(f"repos/{repo}/git/tags/{ref['sha']}")["object"]["sha"] if ref["type"] == "tag" else ref["sha"]
                cache[repo] = {"releaseTag": tag, "releaseCommitSha": commit,
                               "releaseUrl": release["html_url"], "releasePublishedAt": release["published_at"],
                               "releaseLookupStatus": "VERIFIED_REFERENCE_ONLY"}
            except (urllib.error.URLError, TimeoutError, KeyError) as exc:
                cache[repo] = {"releaseLookupStatus": "LOOKUP_FAILED", "releaseLookupError": type(exc).__name__}
        record.update(cache[repo])
        records.append(record)
        print(candidate["id"], record.get("releaseTag"), record["releaseLookupStatus"], flush=True)
    (ROOT / "registry/verified-registry.json").write_text(json.dumps(records, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
