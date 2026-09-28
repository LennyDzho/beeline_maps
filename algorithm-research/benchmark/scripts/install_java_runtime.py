"""Install portable, checksum-verified Java/Maven only inside this research tree."""
import hashlib
import json
import urllib.request
import zipfile
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RUNTIME = ROOT / "runtime"


def fetch(url):
    with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "Marsh-local-benchmark/1.0"}), timeout=90) as response:
        return response.read()


def install(url, checksum, algorithm):
    downloads = RUNTIME / "downloads"
    downloads.mkdir(parents=True, exist_ok=True)
    archive = downloads / url.rsplit("/", 1)[-1]
    if not archive.exists():
        archive.write_bytes(fetch(url))
    digest = hashlib.new(algorithm, archive.read_bytes()).hexdigest()
    if digest != checksum.strip().split()[0]:
        raise RuntimeError(f"Checksum mismatch: {archive.name}")
    with zipfile.ZipFile(archive) as package:
        for name in package.namelist():
            target = (RUNTIME / name).resolve()
            if not target.is_relative_to(RUNTIME.resolve()):
                raise RuntimeError("Archive contains an unsafe path")
        top = package.namelist()[0].split("/")[0]
        if not (RUNTIME / top).exists():
            package.extractall(RUNTIME)
    return top, {"url": url, algorithm: digest, "archive": str(archive.relative_to(ROOT))}


def main():
    manifest = ROOT / "registry/java-runtime.json"
    if manifest.exists():
        print(manifest.read_text(encoding="utf-8"))
        return
    api = "https://api.adoptium.net/v3/assets/latest/21/hotspot?architecture=x64&image_type=jdk&os=windows"
    data = json.loads(fetch(api))[0]
    package = data["binary"]["package"]
    java_dir, jdk = install(package["link"], package["checksum"], "sha256")
    maven_url = "https://repo.maven.apache.org/maven2/org/apache/maven/apache-maven/3.9.11/apache-maven-3.9.11-bin.zip"
    maven_dir, maven = install(maven_url, fetch(maven_url + ".sha512").decode(), "sha512")
    result = {"verifiedAt": datetime.now(timezone.utc).isoformat(),
        "javaHome": f"runtime/{java_dir}", "javaVersion": data["version"]["semver"],
        "mavenHome": f"runtime/{maven_dir}", "mavenVersion": "3.9.11", "jdk": jdk, "maven": maven,
        "scope": "Portable research runtime; no system installation or global environment changes"}
    manifest.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
