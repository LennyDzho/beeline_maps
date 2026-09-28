"""Install the official pinned CBC release only inside the research runtime."""
import hashlib
import json
import urllib.request
import zipfile
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
NAME = "Cbc-releases.2.10.13-windows-2025-msvs-v17-Release-x64.zip"
URL = "https://github.com/coin-or/Cbc/releases/download/releases%2F2.10.13/" + NAME
SHA256 = "7e86255c6337c9abe0df8edf3e0e8a9679e6c8711b8e1929542593b817b04391"


def main():
    archives = ROOT / "runtime/downloads"
    archives.mkdir(parents=True, exist_ok=True)
    archive = archives / NAME
    if not archive.exists():
        req = urllib.request.Request(URL, headers={"User-Agent": "MMI-Algorithm-Research/1.0"})
        with urllib.request.urlopen(req, timeout=55) as response:
            archive.write_bytes(response.read())
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    if digest != SHA256:
        raise ValueError("CBC release checksum does not match the official GitHub asset")
    target = (ROOT / "runtime/cbc-2.10.13").resolve()
    target.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(archive) as bundle:
        for member in bundle.infolist():
            if not (target / member.filename).resolve().is_relative_to(target):
                raise ValueError("Unsafe archive member path")
        bundle.extractall(target)
    binaries = list(target.rglob("cbc.exe"))
    if len(binaries) != 1:
        raise ValueError(f"Expected one CBC executable, found {len(binaries)}")
    data = {"solver": "cbc", "version": "2.10.13", "executable": str(binaries[0].relative_to(ROOT)).replace("\\", "/"),
        "releaseUrl": "https://github.com/coin-or/Cbc/releases/tag/releases/2.10.13", "archiveUrl": URL,
        "sha256": digest, "installedAt": datetime.now(timezone.utc).isoformat(), "license": "EPL-2.0"}
    (ROOT / "registry/cbc-runtime.json").write_text(json.dumps(data, indent=2)+"\n", encoding="utf-8")
    print(json.dumps(data))


if __name__ == "__main__":
    main()
