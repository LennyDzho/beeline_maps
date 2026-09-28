"""Core checks; these do NOT substitute for solver-by-solver T01-T23 runs."""

import copy
import itertools
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from core.metrics import calculate_metrics
from core.preflight import DataNotReady, require_ready
from core.solution_model import dominating_weights, objective_tuple
from core.validator import validate


def fixture():
    matrix = {a: {b: (0 if a == b else 1200) for b in ["s", "j", "k"]} for a in ["s", "j", "k"]}
    problem = {
        "workers": [{"id": "w", "divisionId": "d", "skills": ["local"], "transportMode": "car",
                     "shiftStart": 9*3600, "shiftEnd": 18*3600, "availableAt": 9*3600,
                     "startLocationId": "s", "startCoordinates": {"lat": 55.7, "lon": 37.6},
                     "qualifications": [], "equipment": []}],
        "jobs": [{"id": "j", "divisionId": "d", "requiredSkill": "local", "requiredTransportMode": None,
                  "locationId": "j", "coordinates": {"lat": 55.8, "lon": 37.7}, "windowStart": 10*3600,
                  "windowEnd": 12*3600, "releaseTime": 9*3600, "serviceDuration": 2400,
                  "isEmergency": False, "requiredQualifications": [], "requiredEquipment": []}],
        "travelTimeMatrices": {"car": matrix}, "distanceMatrices": {"car": copy.deepcopy(matrix)},
        "matrixVersion": "fixed-test", "fixedActivities": [], "protectedActivities": [],
        "eventAt": None, "previousSolution": None,
    }
    solution = {"status": "FEASIBLE", "routes": [{"workerId": "w", "startLocationId": "s",
        "departure": 9*3600+20*60, "visits": [{"jobId": "j", "start": 10*3600, "finish": 10*3600+2400}]}], "unassigned": []}
    return problem, solution


class CoreTests(unittest.TestCase):
    def test_early_arrival_waiting(self):
        p, s = fixture()
        m = calculate_metrics(p, s)
        self.assertEqual(m["hardViolations"], 0)
        self.assertEqual(m["waitingMinutes"], 20)
        self.assertEqual(m["travelMinutes"], 20)
        self.assertEqual(m["serviceMinutes"], 40)

    def test_finish_after_window_is_valid_but_after_shift_is_not(self):
        p, s = fixture()
        v = s["routes"][0]["visits"][0]
        v.update(start=11*3600+50*60, finish=12*3600+30*60)
        self.assertEqual(validate(p, s)["totalHardViolations"], 0)
        p["workers"][0]["shiftEnd"] = 12*3600+20*60
        self.assertGreater(validate(p, s)["H06"], 0)

    def test_time_window_upper_bound_and_release(self):
        p, s = fixture()
        v = s["routes"][0]["visits"][0]
        v.update(start=12*3600, finish=12*3600+2400)
        self.assertEqual(validate(p, s)["H05"], 0)
        v.update(start=12*3600+1, finish=12*3600+2401)
        self.assertGreater(validate(p, s)["H05"], 0)
        p["jobs"][0]["releaseTime"] = 13*3600
        self.assertGreater(validate(p, s)["H05"], 0)

    def test_skills_division_transport_resources(self):
        for key, value, code in [("requiredSkill", "other", "H03"), ("divisionId", "other", "H02"),
                                  ("requiredTransportMode", "walk", "H04"), ("requiredEquipment", ["ladder"], "H12")]:
            with self.subTest(key=key):
                p, s = fixture()
                p["jobs"][0][key] = value
                self.assertGreater(validate(p, s)[code], 0)

    def test_open_route_no_return_required(self):
        p, s = fixture()
        p["workers"][0]["shiftEnd"] = 10*3600+2400
        p["travelTimeMatrices"]["car"]["j"]["s"] = 999999
        self.assertEqual(validate(p, s)["totalHardViolations"], 0)

    def test_unreachable_not_zero_and_metrics_refuse_invalid(self):
        p, s = fixture()
        p["travelTimeMatrices"]["car"]["s"]["j"] = None
        self.assertGreater(validate(p, s)["H08"], 0)
        self.assertFalse(calculate_metrics(p, s)["eligibleForComparison"])

    def test_overlaps_and_road_gap(self):
        p, s = fixture()
        job = dict(p["jobs"][0], id="k", locationId="k")
        p["jobs"].append(job)
        s["routes"][0]["visits"].append({"jobId": "k", "start": 10*3600+2700, "finish": 10*3600+5100})
        self.assertEqual(validate(p, s)["H07"], 0)
        self.assertGreater(validate(p, s)["H08"], 0)
        s["routes"][0]["visits"][1].update(start=10*3600+1800, finish=10*3600+4200)
        self.assertGreater(validate(p, s)["H07"], 0)

    def test_no_missing_or_duplicate_jobs(self):
        p, s = fixture()
        s["unassigned"] = ["j"]
        self.assertGreater(validate(p, s)["H01"], 0)
        s["unassigned"] = []
        s["routes"][0]["visits"] = []
        self.assertGreater(validate(p, s)["H01"], 0)

    def test_start_fixed_and_past_protection(self):
        p, s = fixture()
        s["routes"][0]["startLocationId"] = "j"
        self.assertGreater(validate(p, s)["H09"], 0)
        p, s = fixture()
        p["protectedActivities"] = [{"jobId": "j", "workerId": "w", "start": 11*3600, "finish": 11*3600+2400}]
        self.assertGreater(validate(p, s)["H10"], 0)
        p["eventAt"] = 11*3600
        self.assertGreater(validate(p, s)["H11"], 0)

    def test_preflight_blocks_missing_matrix_before_solver(self):
        p, _ = fixture()
        require_ready(p)
        p["travelTimeMatrices"] = {}
        with self.assertRaises(DataNotReady):
            require_ready(p)

    def test_preflight_accepts_unserviceable_job(self):
        p, _ = fixture()
        p["jobs"][0]["requiredSkill"] = "missing"
        require_ready(p)

    def test_proven_scalar_dominance_for_all_small_vectors(self):
        bounds = [2, 3, 7]
        weights = dominating_weights(bounds)
        vectors = list(itertools.product(*(range(x+1) for x in bounds)))
        self.assertEqual(vectors, sorted(vectors, key=lambda v: sum(a*b for a, b in zip(v, weights))))

    def test_primary_coverage_then_staff(self):
        base = {"hardViolations": 0, "served": 8, "workersUsed": 3, "distanceMetres": 1000}
        self.assertLess(objective_tuple(base), objective_tuple(dict(base, served=7, workersUsed=2)))
        self.assertLess(objective_tuple(dict(base, workersUsed=2, distanceMetres=99999)), objective_tuple(base))

    def test_emergency_delay_and_no_emergency_null(self):
        p, s = fixture()
        self.assertIsNone(calculate_metrics(p, s)["meanResponseDelay"])
        p["jobs"][0]["isEmergency"] = True
        m = calculate_metrics(p, s)
        self.assertEqual(m["meanResponseDelay"], 60)
        self.assertEqual(m["meanCompletionDelay"], 100)


if __name__ == "__main__":
    unittest.main()
