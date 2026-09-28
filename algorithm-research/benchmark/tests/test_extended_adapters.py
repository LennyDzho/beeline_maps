"""Shared protected-scheduling and objective tradeoff checks for two methods."""
import importlib
import sys
import unittest
from pathlib import Path
sys.path[:0]=[str(Path(__file__).resolve().parents[1]),str(Path(__file__).resolve().parents[1]/"scripts")]
from run_regression_matrix import solver_case
from core.metrics import calculate_metrics


class ExtendedAdapterTests(unittest.TestCase):
    def test_fixed_visit_and_earliest_emergency(self):
        p,policy,_=solver_case("T14")
        for name in ["alns_extended","timefold_extended","ortools_routing_extended"]:
            with self.subTest(adapter=name):
                s=importlib.import_module("adapters."+name).solve(p,policy,1,1)
                m=calculate_metrics(p,s)
                self.assertEqual(m["hardViolations"],0,m)
                self.assertEqual((m["served"],m["meanResponseDelay"]),(2,15),s)

    def test_policy_tradeoff_is_explicit(self):
        p,_,_=solver_case("T18")
        for name in ["alns_extended","timefold_extended","ortools_routing_extended"]:
            for policy,workers,delay in [("POLICY_FAST_RESPONSE",2,15),("POLICY_MIN_STAFF",1,315)]:
                with self.subTest(adapter=name,policy=policy):
                    s=importlib.import_module("adapters."+name).solve(p,policy,1,1)
                    m=calculate_metrics(p,s)
                    self.assertEqual(m["hardViolations"],0,m)
                    self.assertEqual((m["served"],m["workersUsed"],m["meanResponseDelay"]),(1,workers,delay),s)


if __name__=="__main__":unittest.main()
