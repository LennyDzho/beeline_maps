import copy
import importlib
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from core.metrics import calculate_metrics
from test_core import fixture


class ReferenceAdapterTests(unittest.TestCase):
    def test_each_engine_solves_known_open_route_optimum(self):
        for engine in ["cpsat", "scip", "cbc"]:
            with self.subTest(engine=engine):
                p, _ = fixture()
                solution = importlib.import_module("adapters."+engine).solve(p, "PRIMARY", 0.3, 1)
                m = calculate_metrics(p, solution)
                self.assertEqual((m["hardViolations"], m["served"], m["workersUsed"], m["distanceMetres"]), (0, 1, 1, 1200))
                self.assertEqual(solution["status"], "OPTIMAL")

    def test_each_engine_drops_unreachable_job(self):
        for engine in ["cpsat", "scip", "cbc"]:
            with self.subTest(engine=engine):
                p, _ = fixture()
                p["travelTimeMatrices"]["car"]["s"]["j"] = None
                p["distanceMatrices"]["car"]["s"]["j"] = None
                solution = importlib.import_module("adapters."+engine).solve(p, "PRIMARY", 0.3, 1)
                self.assertEqual(solution["unassigned"], ["j"])
                self.assertEqual(calculate_metrics(p, solution)["hardViolations"], 0)

    def test_each_engine_keeps_skill_constraint_hard(self):
        for engine in ["cpsat", "scip", "cbc"]:
            with self.subTest(engine=engine):
                p, _ = fixture()
                p["workers"][0]["skills"] = ["other"]
                solution = importlib.import_module("adapters."+engine).solve(p, "PRIMARY", 0.3, 1)
                self.assertEqual(solution["unassigned"], ["j"])
                self.assertEqual(calculate_metrics(p, solution)["hardViolations"], 0)


if __name__ == "__main__":
    unittest.main()
