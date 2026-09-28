import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from adapters.alns import solve
from core.metrics import calculate_metrics
from test_core import fixture


class ALNSAdapterTests(unittest.TestCase):
    def test_tiny_route(self):
        p, _ = fixture()
        m = calculate_metrics(p, solve(p, "PRIMARY", 0.05, 1))
        self.assertEqual((m["hardViolations"], m["served"], m["distanceMetres"]), (0, 1, 1200))

    def test_no_compatible_worker(self):
        p, _ = fixture()
        p["workers"][0]["skills"] = ["other"]
        m = calculate_metrics(p, solve(p, "PRIMARY", 0.05, 1))
        self.assertEqual((m["hardViolations"], m["served"]), (0, 0))

    def test_unreachable(self):
        p, _ = fixture()
        p["travelTimeMatrices"]["car"]["s"]["j"] = None
        p["distanceMatrices"]["car"]["s"]["j"] = None
        m = calculate_metrics(p, solve(p, "PRIMARY", 0.05, 1))
        self.assertEqual((m["hardViolations"], m["served"]), (0, 0))
