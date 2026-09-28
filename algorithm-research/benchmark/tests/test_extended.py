import copy
import sys
import unittest
from pathlib import Path

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from test_core import fixture
from adapters.alns_extended import solve
from core.metrics import calculate_metrics
from core.replanning import freeze_at,change_log,explain_unassigned
from core.publication import PlanStore,StalePlanError


class ExtendedTests(unittest.TestCase):
    def test_two_policies_expose_response_staff_tradeoff(self):
        p,_=fixture()
        p["workers"][0].update(availableAt=16*3600,shiftEnd=22*3600)
        p["workers"].append({**p["workers"][0],"id":"spare","availableAt":11*3600})
        p["jobs"][0].update(isEmergency=True,releaseTime=11*3600,windowStart=0,windowEnd=86399,serviceDuration=4800)
        p["pastActivities"]=[{"workerId":"w","jobId":"committed","start":10*3600,"finish":16*3600}]
        fast=calculate_metrics(p,solve(p,"POLICY_FAST_RESPONSE",.1,1))
        staff=calculate_metrics(p,solve(p,"POLICY_MIN_STAFF",.1,1))
        self.assertEqual((fast["hardViolations"],staff["hardViolations"]),(0,0))
        self.assertEqual((fast["workersUsed"],staff["workersUsed"]),(2,1))
        self.assertEqual((fast["meanResponseDelay"],staff["meanResponseDelay"]),(20,320))

    def test_emergency_is_early_and_anchor_unchanged(self):
        p,s=fixture()
        p["workers"][0]["availableAt"]=11*3600
        p["travelTimeMatrices"]["car"]["s"]["j"]=900
        p["jobs"][0].update(isEmergency=True,releaseTime=11*3600,windowStart=0,windowEnd=86399,serviceDuration=4800)
        p["jobs"].append({**p["jobs"][0],"id":"k","locationId":"k","isEmergency":False,"serviceDuration":1200})
        p["travelTimeMatrices"]["car"]["j"]["k"]=900
        p["fixedActivities"]=[{"jobId":"k","workerId":"w","start":13*3600,"finish":13*3600+1200}]
        for policy in ["POLICY_FAST_RESPONSE","POLICY_MIN_STAFF"]:
            result=solve(p,policy,.15,1)
            m=calculate_metrics(p,result)
            self.assertEqual(m["hardViolations"],0,m)
            self.assertEqual(m["served"],2,result)
            self.assertEqual(m["meanResponseDelay"],15)

    def test_started_travel_keeps_worker_busy(self):
        p,s=fixture()
        event=9*3600+30*60
        remaining=freeze_at(p,s,event)
        self.assertEqual(remaining["pastActivities"][0]["stateAtEvent"],"en_route")
        self.assertEqual(remaining["workers"][0]["availableAt"],s["routes"][0]["visits"][0]["finish"])
        self.assertEqual(remaining["workers"][0]["currentLocationId"],"j")
        self.assertEqual(remaining["jobs"],[])

    def test_history_survives_unassignment(self):
        _,s=fixture(); empty={"routes":[]}
        first=change_log(empty,s,"initial")
        self.assertIsNone(first[0]["reason"])
        removed=change_log(s,empty,"manual",first)
        moved=copy.deepcopy(s); moved["routes"][0]["workerId"]="other"
        again=change_log(empty,moved,"manual",removed)
        self.assertFalse(again[-1]["firstAssignment"])
        self.assertIsNotNone(again[-1]["reason"])
        self.assertEqual(len(again),3)

    def test_stale_publication_rolls_back_all_divisions(self):
        store=PlanStore(); store.seed("a",1,{"old":1}); store.seed("b",2,{"old":2})
        before=store.snapshot()
        with self.assertRaises(StalePlanError): store.publish({"a":{},"b":{}},{"a":1,"b":1})
        self.assertEqual(store.snapshot(),before)
        store.publish({"a":{"new":1},"b":{"new":2}},{"a":1,"b":2})
        self.assertEqual(store.snapshot()["a"]["version"],2)
        self.assertEqual(store.snapshot()["b"]["version"],3)

    def test_transport_reason_is_specific(self):
        p,_=fixture(); p["workers"][0]["transportMode"]="walk"; p["jobs"][0]["requiredTransportMode"]="car"
        reasons=explain_unassigned(p,{"unassigned":["j"]})
        self.assertEqual(reasons[0]["code"],"TRANSPORT")


if __name__=="__main__": unittest.main()
