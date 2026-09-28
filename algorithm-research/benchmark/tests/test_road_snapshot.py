import copy
import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "scripts"))
from build_road_snapshot import geocoded_problem, nodes_by_division
from core.preflight import check_problem
from core.problem_model import fingerprint


class RoadSnapshotTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.problem = json.loads((ROOT / "datasets/problem.json").read_text(encoding="utf-8"))

    def test_geography_requires_explicit_scenario(self):
        with self.assertRaisesRegex(RuntimeError, "BLOCKED_DATA"):
            geocoded_problem(False)
        model, points = geocoded_problem(True)
        self.assertEqual(len(model["geocodingAssumptions"]), 8)
        self.assertEqual(len(points), 206)
        self.assertEqual(len(model["jobs"]), 203)

    def test_complete_single_provider_snapshot(self):
        p = self.problem
        self.assertEqual(p["matrixProvenance"]["provider"], "OSM/OSRM")
        self.assertEqual(check_problem(p)["status"], "READY")
        self.assertEqual(p["matrixVersion"], fingerprint({"times": p["travelTimeMatrices"]["car"], "distances": p["distanceMatrices"]["car"]}))
        self.assertEqual(sum(len(nodes)**2 for _, nodes in nodes_by_division(p)), 14462)

    def test_cached_osrm_values_are_used_without_2gis_arcs(self):
        p = self.problem
        blocks = [json.loads(path.read_text(encoding="utf-8")) for path in (ROOT / "matrices/osrm-blocks").glob("*.json")]
        import math
        for division, nodes in nodes_by_division(p):
            response = next(b["response"] for b in blocks if len(b["response"]["sources"]) == len(nodes))
            for i, origin in enumerate(nodes):
                for j, target in enumerate(nodes):
                    self.assertEqual(p["travelTimeMatrices"]["car"][origin][target], math.ceil(response["durations"][i][j]))
                    self.assertEqual(p["distanceMatrices"]["car"][origin][target], math.ceil(response["distances"][i][j]))

    def test_missing_arc_blocks_optimizer(self):
        p = copy.deepcopy(self.problem)
        origin = next(iter(p["travelTimeMatrices"]["car"]))
        p["travelTimeMatrices"]["car"][origin].popitem()
        result = check_problem(p)
        self.assertEqual(result["status"], "BLOCKED_DATA")
        self.assertIn("MATRIX_CELL_MISSING", {x["code"] for x in result["issues"]})


if __name__ == "__main__":
    unittest.main()
