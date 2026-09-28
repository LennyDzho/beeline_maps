"""Small controlled integration checks, distinct from the full T01-T23 matrix."""

import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from adapters.ortools_routing import solve
from core.metrics import calculate_metrics
from test_core import fixture
from runner import run_once


class RoutingAdapterTests(unittest.TestCase):
    def test_one_job_is_served_with_service_start_window(self):
        p, _ = fixture()
        result = solve(p, "PRIMARY", 0.05, 1)
        metrics = calculate_metrics(p, result)
        self.assertEqual(metrics["hardViolations"], 0)
        self.assertEqual(metrics["served"], 1)
        self.assertEqual(metrics["workersUsed"], 1)
        self.assertEqual(metrics["distanceMetres"], 1200)

    def test_unreachable_job_is_explicitly_unassigned(self):
        p, _ = fixture()
        p["travelTimeMatrices"]["car"]["s"]["j"] = None
        p["distanceMatrices"]["car"]["s"]["j"] = None
        result = solve(p, "PRIMARY", 0.05, 1)
        self.assertEqual(result["unassigned"], ["j"])
        self.assertEqual(calculate_metrics(p, result)["hardViolations"], 0)

    def test_runner_does_not_import_adapter_before_ready(self):
        p, _ = fixture()
        p.update(id="fixture", datasetVersion="test")
        p["travelTimeMatrices"] = {}
        with patch("runner.importlib.import_module", side_effect=AssertionError("Must not import adapter")):
            result = run_once(p, "ortools_routing", "PRIMARY", 1, 1)
        self.assertEqual(result["status"], "BLOCKED_DATA")
        self.assertIsNone(result["metrics"])


if __name__ == "__main__":
    unittest.main()
