import copy
import unittest
from solver import solve, hierarchy


def fixture():
    n=4
    durations=[[0 if a==b or b==3 else 60 for b in range(n)] for a in range(n)]
    distances=[[0 if a==b or b==3 else 100 for b in range(n)] for a in range(n)]
    return {"version":1,"policy":"emergency_fast/v1","horizonSeconds":3600,"timeLimitMs":150,
        "jobs":[{"id":f"J{i}","serviceSeconds":300,"windows":[[0,3300]],"releaseAt":0,"emergency":False,"eligibleAgentIds":["A","B"]} for i in range(2)],
        "agents":[{"id":i,"shiftId":f"S-{i}","start":0,"end":3600,"breaks":[],"durations":copy.deepcopy(durations),"distances":copy.deepcopy(distances)} for i in ["A","B"]]}


class SolverTests(unittest.TestCase):
    solve = staticmethod(solve)

    def test_coverage_then_staff_then_distance(self):
        data=fixture()
        result=self.solve(data)
        self.assertEqual(result["unassigned"],[])
        self.assertEqual(len(result["routes"]),1)
        self.assertEqual(len(result["routes"][0]["visits"]),2)
        data["jobs"][0]["windows"]=[[60,60]]
        data["jobs"][1]["windows"]=[[60,60]]
        result=self.solve(data)
        self.assertEqual(result["unassigned"],[])
        self.assertEqual(len(result["routes"]),2,"coverage dominates minimum staff")

    def test_window_constrains_start_not_finish_and_shift_constrains_finish(self):
        data=fixture()
        data["jobs"][0]["windows"]=[[600,600]]
        result=self.solve(data)
        visit=next(v for r in result["routes"] for v in r["visits"] if v["jobId"]=="J0")
        self.assertEqual(visit["start"],600)
        data["jobs"][0]["windows"]=[[3500,3500]]
        self.assertIn("J0",self.solve(data)["unassigned"])

    def test_all_hd_eligibility_and_directed_unreachable_paths(self):
        data=fixture()
        data["jobs"][0]["eligibleAgentIds"]=[]
        self.assertIn("J0",self.solve(data)["unassigned"])
        data=fixture()
        for agent in data["agents"]:
            for row in agent["durations"]:
                row[0]=None
        self.assertIn("J0",self.solve(data)["unassigned"])

    def test_earliest_emergency_vs_staff_is_an_explicit_policy(self):
        data=fixture()
        data["jobs"][0].update(windows=[[60,60]],serviceSeconds=600,eligibleAgentIds=["A"])
        data["jobs"][1].update(emergency=True,releaseAt=60)
        fast=self.solve(data)
        fast_visit=next(v for r in fast["routes"] for v in r["visits"] if v["jobId"]=="J1")
        self.assertEqual(fast_visit["start"],60)
        self.assertEqual(len(fast["routes"]),2)
        data["policy"]="emergency_staff/v1"
        staff=self.solve(data)
        self.assertEqual(staff["unassigned"],[])
        self.assertEqual(len(staff["routes"]),1)
        self.assertGreater(next(v["start"] for v in staff["routes"][0]["visits"] if v["jobId"]=="J1"),60)

    def test_break_does_not_split_service_or_drive_but_allows_waiting(self):
        data=fixture()
        data["jobs"][0]["windows"]=[[700,700]]
        data["jobs"][1]["windows"]=[[1400,1400]]
        for agent in data["agents"]:
            agent["breaks"]=[[600,1200]]
            agent["durations"][2][1]=500
        result=self.solve(data)
        self.assertIn("J0",result["unassigned"])
        visit=next(v for r in result["routes"] for v in r["visits"] if v["jobId"]=="J1")
        self.assertLessEqual(visit["arrival"],600,"may arrive before break and wait for client window")

    def test_heterogeneous_travel_and_explicit_limits(self):
        data=fixture()
        data["agents"][0]["maxJobs"]=1
        data["agents"][1]["maxJobs"]=1
        self.assertEqual(len(self.solve(data)["routes"]),2)
        data["agents"][1]["maxDistanceMeters"]=50
        self.assertEqual(len(self.solve(data)["unassigned"]),1)

    def test_fixed_service_is_not_moved(self):
        data=fixture()
        data["jobs"][0]["fixed"]={"agentId":"B","start":1000}
        result=self.solve(data)
        route=next(r for r in result["routes"] if any(v["jobId"]=="J0" for v in r["visits"]))
        self.assertEqual(route["agentId"],"B")
        self.assertEqual(next(v["start"] for v in route["visits"] if v["jobId"]=="J0"),1000)

    def test_objective_weights_dominate_every_lower_tier(self):
        data=fixture()
        data["jobs"][0]["emergency"]=True
        weights,bounds=hierarchy(data["jobs"],data["agents"],3600,data["policy"])
        names=list(weights)
        for i,name in enumerate(names[:-1]):
            self.assertGreater(weights[name],sum(weights[n]*bounds[n] for n in names[i+1:]))

    def test_protected_worker_does_not_cost_an_additional_person(self):
        data=fixture()
        data["agents"][0]["alreadyEngaged"]=True
        data["agents"][0]["distances"]=[[v*10 for v in row] for row in data["agents"][0]["distances"]]
        result=self.solve(data)
        self.assertEqual(result["unassigned"],[])
        self.assertEqual([r["agentId"] for r in result["routes"]],["A"],"reuse one already engaged person before shortening distance")


class PyVrpSolverTests(SolverTests):
    from pyvrp_solver import solve as pyvrp_solve
    solve = staticmethod(pyvrp_solve)

    def test_replanning_releases_heterogeneous_agents_and_preserves_fixed_work(self):
        data=fixture()
        data["agents"][0].update(start=1000,alreadyEngaged=True)
        data["agents"][1].update(start=2000)
        data["agents"][0]["durations"][2][1]=200
        data["jobs"][0]["fixed"]={"agentId":"A","start":1500}
        data["jobs"][1].update(emergency=True,releaseAt=1000,serviceSeconds=240,windows=[[0,50],[1100,1300]])
        result=self.solve(data)
        self.assertEqual(result["unassigned"],[])
        visits={v["jobId"]:v for r in result["routes"] for v in r["visits"]}
        self.assertEqual(visits["J0"]["start"],1500)
        self.assertEqual(visits["J1"]["start"],1200)

    def test_emergency_replaces_ordinary_job_at_full_capacity(self):
        data=fixture();data["agents"]=data["agents"][:1]
        data["agents"][0]["maxJobs"]=1
        for job in data["jobs"]:job["eligibleAgentIds"]=["A"]
        data["jobs"][1]["emergency"]=True
        result=self.solve(data)
        self.assertEqual(result["unassigned"],["J0"])

    def test_travel_break_return_and_travel_budget(self):
        data=fixture();data["jobs"][1]["eligibleAgentIds"]=[]
        for agent in data["agents"]:
            agent["breaks"]=[[400,800]]
            agent["durations"][0][3]=100
        result=self.solve(data)
        self.assertEqual(result["routes"][0]["end"],900)
        for agent in data["agents"]:agent["maxTravelSeconds"]=159
        self.assertEqual(len(self.solve(data)["unassigned"]),2)

    def test_dispatch_rejects_unknown_engine_and_uses_pyvrp(self):
        from solver import dispatch
        data=fixture();data["engine"]="unknown"
        with self.assertRaises(ValueError):dispatch(data)
        data["engine"]="pyvrp"
        self.assertEqual(dispatch(data)["engine"],"pyvrp")


if __name__=="__main__":
    unittest.main()
