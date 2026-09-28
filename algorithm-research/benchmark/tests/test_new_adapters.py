"""Cross-adapter checks for VROOM/jsprit/Timefold/Choco; not the full T01–T23 suite."""
import copy
import importlib
import os
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from core.metrics import calculate_metrics
from test_core import fixture


class NewAdapterTests(unittest.TestCase):
    engines = os.environ.get("BENCHMARK_CHECK_SOLVERS", "vroom jsprit timefold choco").split()

    def check(self, problem, served, workers=None, worker_id=None):
        for engine in self.engines:
            with self.subTest(engine=engine):
                result = importlib.import_module("adapters."+engine).solve(copy.deepcopy(problem), "PRIMARY", 1, 1)
                metrics = calculate_metrics(problem,result)
                self.assertNotEqual(result["status"],"NO_SOLUTION_FOUND")
                self.assertEqual(metrics["hardViolations"],0,metrics)
                self.assertEqual(metrics["served"],served,result)
                if workers is not None:
                    self.assertEqual(metrics["workersUsed"],workers,result)
                if worker_id is not None:
                    self.assertEqual(result["routes"][0]["workerId"],worker_id,result)

    def test_service_can_finish_after_window(self):
        p,_=fixture()
        p["jobs"][0].update(windowStart=11*3600+50*60,windowEnd=12*3600)
        self.check(p,1,1)

    def test_service_cannot_finish_after_shift(self):
        p,_=fixture()
        p["jobs"][0].update(windowStart=11*3600+50*60,windowEnd=12*3600)
        p["workers"][0]["shiftEnd"]=12*3600+20*60
        self.check(p,0,0)

    def test_unreachable_arc_is_not_zero(self):
        p,_=fixture()
        p["travelTimeMatrices"]["car"]["s"]["j"]=None
        p["distanceMatrices"]["car"]["s"]["j"]=None
        self.check(p,0,0)

    def test_eligibility_is_mandatory(self):
        for changed in [{"skills":["other"]},{"divisionId":"other"},{"qualifications":[]}]:
            p,_=fixture()
            p["workers"].append({**p["workers"][0],"id":"eligible"})
            if "qualifications" in changed:
                p["jobs"][0]["requiredQualifications"]=["permit"]
                p["workers"][1]["qualifications"]=["permit"]
            p["workers"][0].update(changed)
            self.check(p,1,1,"eligible")

    def test_no_return_leg(self):
        p,_=fixture()
        p["jobs"][0].update(windowStart=10*3600,windowEnd=10*3600)
        p["workers"][0]["shiftEnd"]=10*3600+2400
        p["travelTimeMatrices"]["car"]["j"]["s"]=50000
        self.check(p,1,1)

    def test_fleet_size_precedes_distance(self):
        p,_=fixture()
        p["workers"].append({**p["workers"][0],"id":"w2"})
        p["jobs"].append({**p["jobs"][0],"id":"k","locationId":"k"})
        # Two workers: distance 2; one worker: distance 1001. Staff wins.
        dm=p["distanceMatrices"]["car"]
        dm["s"]["j"]=dm["s"]["k"]=1
        dm["j"]["k"]=dm["k"]["j"]=1000
        self.check(p,2,1)


if __name__ == "__main__":
    unittest.main()
