"""Check that the report's necessary staff bound respects skills and capacity."""
import copy
import sys
import unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
sys.path[:0]=[str(ROOT),str(ROOT/"tests")]
from test_core import fixture
from scripts.structural_lower_bounds import calculate


class StructuralBoundsTests(unittest.TestCase):
    def test_service_capacity_strengthens_qualification_cover(self):
        p,_=fixture();p["datasetVersion"]="test"
        w=p["workers"][0];w.update(shiftStart=0,shiftEnd=3600,availableAt=0)
        p["workers"].append({**copy.deepcopy(w),"id":"w2"})
        j=p["jobs"][0];j.update(windowStart=0,windowEnd=3600,releaseTime=0,serviceDuration=2400)
        p["jobs"].append({**copy.deepcopy(j),"id":"j2"})
        r=calculate(p)
        self.assertEqual(r["divisions"][0]["qualificationCoverageLowerBound"],1)
        self.assertEqual(r["staffLowerBoundForFullCoverage"],2)

    def test_different_workers_cannot_combine_their_hd_for_one_job(self):
        p,_=fixture();p["datasetVersion"]="test"
        p["jobs"][0].update(bkType="bk",requiredHdTypes=["a","b"])
        p["workers"][0]["supportedHdTypes"]={"bk":["a"]}
        p["workers"].append({**copy.deepcopy(p["workers"][0]),"id":"w2","supportedHdTypes":{"bk":["b"]}})
        with self.assertRaisesRegex(ValueError,"Full coverage impossible"):calculate(p)
        p["workers"][1]["supportedHdTypes"]={"bk":["a","b"]}
        self.assertEqual(calculate(p)["staffLowerBoundForFullCoverage"],1)

    def test_independent_division_bounds_add(self):
        p,_=fixture();p["datasetVersion"]="test"
        p["workers"].append({**copy.deepcopy(p["workers"][0]),"id":"w2","divisionId":"second"})
        p["jobs"].append({**copy.deepcopy(p["jobs"][0]),"id":"j2","divisionId":"second"})
        self.assertEqual(calculate(p)["staffLowerBoundForFullCoverage"],2)


if __name__=="__main__":unittest.main()
