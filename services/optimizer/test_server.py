"""Real loopback HTTP, real solver; only watchdog expiry is simulated."""
import http.client
import json
import subprocess
import threading
import unittest
from unittest.mock import patch

import server
from test_solver import fixture


class HttpTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.environment = patch.dict(server.os.environ, {"OPTIMIZER_SERVICE_TOKEN": "isolated-test-token"})
        cls.environment.start()
        cls.http = server.ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        cls.thread = threading.Thread(target=cls.http.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.http.shutdown()
        cls.http.server_close()
        cls.thread.join(timeout=5)
        cls.environment.stop()

    def request(self, body=None, *, path="/v1/solve", token="isolated-test-token", headers=None, method="POST"):
        connection = http.client.HTTPConnection(*self.http.server_address, timeout=10)
        payload = json.dumps(fixture() if body is None else body).encode("utf-8")
        request_headers = {"Content-Type": "application/json", "Authorization": "Bearer " + token}
        request_headers.update(headers or {})
        try:
            connection.request(method, path, body=payload, headers=request_headers)
            response = connection.getresponse()
            return response.status, json.loads(response.read())
        finally:
            connection.close()

    def test_real_http_solve_and_health(self):
        status, result = self.request()
        self.assertEqual(status, 200)
        self.assertEqual(result["status"], "feasible")
        self.assertEqual(result["unassigned"], [])
        self.assertEqual(len(result["routes"]), 1)
        status, health = self.request(method="GET", path="/health", token="")
        self.assertEqual((status, health["protocol"]), (200, 1))

    def test_authentication_and_protocol_rejection(self):
        self.assertEqual(self.request(token="wrong")[0], 401)
        self.assertEqual(self.request(path="/unknown")[0], 404)
        self.assertEqual(self.request(headers={"Content-Type": "text/plain"})[0], 400)
        self.assertEqual(self.request(headers={"Content-Length": str(server.MAX_BODY + 1)})[0], 400)
        self.assertEqual(self.request({"version": 999})[0], 422)
        self.assertEqual(self.request({**fixture(), "engine":"unknown"})[0], 422)

    def test_pyvrp_uses_the_same_authenticated_endpoint(self):
        status, result = self.request({**fixture(), "engine":"pyvrp"})
        self.assertEqual(status, 200)
        self.assertEqual(result["engine"], "pyvrp")
        self.assertEqual(result["unassigned"], [])
        self.assertTrue(result["solverVersion"].startswith("0.14."))

    def test_busy_rejects_without_queueing_and_releases_after_failure(self):
        server.slot.acquire()
        try:
            self.assertEqual(self.request(), (503, {"error": "busy"}))
        finally:
            server.slot.release()
        self.assertEqual(self.request({"version": 999})[0], 422)
        self.assertEqual(self.request()[0], 200)

    def test_watchdog_timeout_does_not_leak_slot_or_diagnostics(self):
        with patch.object(server.subprocess, "run", side_effect=subprocess.TimeoutExpired("private-command", 75)):
            self.assertEqual(self.request(), (504, {"error": "solver_timeout"}))
        self.assertEqual(self.request()[0], 200)


if __name__ == "__main__":
    unittest.main()
