import copy
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from adapters.pyvrp import solve
from core.metrics import calculate_metrics
from test_core import fixture


class PyVRPAdapterTests(unittest.TestCase):
    def test_start_window_open_route_and_distance(self):
        p, _ = fixture()
        result = solve(p, "PRIMARY", 0.05, 1)
        m = calculate_metrics(p, result)
        self.assertEqual((m["hardViolations"], m["served"], m["workersUsed"], m["distanceMetres"]), (0, 1, 1, 1200))

    def test_eligibility_is_hard_and_job_optional(self):
        p, _ = fixture()
        p["workers"][0]["skills"] = ["other"]
        result = solve(p, "PRIMARY", 0.05, 1)
        self.assertEqual(result["unassigned"], ["j"])
        self.assertEqual(calculate_metrics(p, result)["hardViolations"], 0)

    def test_unreachable_is_not_zero_cost_access(self):
        p, _ = fixture()
        p["travelTimeMatrices"]["car"]["s"]["j"] = None
        p["distanceMatrices"]["car"]["s"]["j"] = None
        result = solve(p, "PRIMARY", 0.05, 1)
        self.assertEqual(result["unassigned"], ["j"])
        self.assertEqual(calculate_metrics(p, result)["hardViolations"], 0)


if __name__ == "__main__":
    unittest.main()
