"""Private HTTP bridge. Single solve at a time, bounded subprocess and body size."""
import argparse
import hmac
import json
import os
from pathlib import Path
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MAX_BODY = 32 * 1024 * 1024
slot = threading.BoundedSemaphore(1)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass  # No task coordinates, IDs or authorization headers in HTTP logs.

    def send_json(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            self.send_json(200, {"service":"marsh-optimizer","protocol":1,"engines":["ortools","pyvrp"]})
        else:
            self.send_json(404, {"error":"not_found"})

    def do_POST(self):
        token = os.environ.get("OPTIMIZER_SERVICE_TOKEN", "")
        if token and not hmac.compare_digest(self.headers.get("Authorization", ""), "Bearer " + token):
            self.send_json(401, {"error":"unauthorized"})
            return
        if self.path != "/v1/solve":
            self.send_json(404, {"error":"not_found"})
            return
        try:
            size = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            size = 0
        if not 0 < size <= MAX_BODY or self.headers.get("Content-Type", "").split(";")[0] != "application/json":
            self.send_json(400, {"error":"invalid_body"})
            return
        if not slot.acquire(blocking=False):
            self.send_json(503, {"error":"busy"})
            return
        try:
            self.connection.settimeout(15)
            body = self.rfile.read(size)
            if len(body) != size:
                raise ValueError("Incomplete request")
            json.loads(body)  # Reject invalid JSON before spawning a solver process.
            result = subprocess.run([sys.executable, str(Path(__file__).with_name("solver.py"))], input=body,
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=75, check=False)
            if result.returncode in (0, 2):
                self.send_json(200 if result.returncode == 0 else 422, json.loads(result.stdout))
            else:
                self.send_json(500, {"error":"solver_failed"})
        except subprocess.TimeoutExpired:
            self.send_json(504, {"error":"solver_timeout"})
        except (ValueError, TimeoutError):
            self.send_json(400, {"error":"invalid_body"})
        finally:
            slot.release()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()
    if args.host not in ("localhost", "127.0.0.1", "::1") and not os.environ.get("OPTIMIZER_SERVICE_TOKEN"):
        parser.error("OPTIMIZER_SERVICE_TOKEN is required outside loopback; expose behind HTTPS")
    ThreadingHTTPServer((args.host,args.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
