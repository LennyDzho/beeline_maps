package research;

import java.util.*;
import java.time.Duration;
import ai.timefold.solver.core.api.domain.entity.PlanningEntity;
import ai.timefold.solver.core.api.domain.common.PlanningId;
import ai.timefold.solver.core.api.domain.solution.*;
import ai.timefold.solver.core.api.domain.valuerange.ValueRangeProvider;
import ai.timefold.solver.core.api.domain.variable.PlanningListVariable;
import ai.timefold.solver.core.api.score.BendableScore;
import ai.timefold.solver.core.api.score.calculator.EasyScoreCalculator;
import ai.timefold.solver.core.api.solver.SolverFactory;
import ai.timefold.solver.core.config.solver.SolverConfig;

/** OSS list-variable model with genuine lexicographic score levels. */
public class TimefoldAdapter {
    @PlanningEntity
    public static class WorkerRoute {
        @PlanningId public String id;
        public Bridge.Worker worker;
        @PlanningListVariable(valueRangeProviderRefs={"jobs"},allowsUnassignedValues=true)
        public List<Bridge.Job> jobs = new ArrayList<>();
        public WorkerRoute() {}
        public WorkerRoute(Bridge.Worker w) { id=w.id; worker=w; }
    }
    @PlanningSolution
    public static class Plan {
        @ProblemFactProperty public Bridge.Problem problem;
        @ProblemFactCollectionProperty @ValueRangeProvider(id="jobs") public List<Bridge.Job> jobs;
        @PlanningEntityCollectionProperty public List<WorkerRoute> routes;
        @PlanningScore(bendableHardLevelsSize=1,bendableSoftLevelsSize=3) public BendableScore score;
        public Plan() {}
        public Plan(Bridge.Problem p) { problem=p; jobs=p.jobs; routes=new ArrayList<>(); p.workers.forEach(w->routes.add(new WorkerRoute(w))); }
    }
    public static class Score implements EasyScoreCalculator<Plan,BendableScore> {
        public BendableScore calculateScore(Plan plan) {
            long hard=0,distance=0,used=0,served=0;
            var p=plan.problem;
            for(var r:plan.routes) {
                var w=r.worker; int at=Math.max(w.availableAt,w.shiftStart); String node=w.startLocationId;
                if(!r.jobs.isEmpty()) used++;
                for(var j:r.jobs) {
                    served++;
                    if(!p.eligible(w,j)) hard++;
                    int travel=p.duration(w,node,j.locationId);
                    at=Math.max(at+travel,Math.max(j.windowStart,j.releaseTime));
                    hard+=Math.max(0,at-j.windowEnd);
                    at+=j.serviceDuration;
                    hard+=Math.max(0,at-w.shiftEnd);
                    distance+=p.arc(w,node,j.locationId,true); node=j.locationId;
                }
            }
            return BendableScore.of(new long[]{-hard},new long[]{served-p.jobs.size(),-used,-distance});
        }
    }
    public static Map<String,Object> solve(Bridge.Problem p,double limit,long seed) {
        var config=new SolverConfig().withSolutionClass(Plan.class).withEntityClasses(WorkerRoute.class)
            .withEasyScoreCalculatorClass(Score.class).withRandomSeed(seed).withMoveThreadCount("NONE")
            .withTerminationSpentLimit(Duration.ofMillis(Math.max(1,Math.round(limit*1000))));
        var solver=SolverFactory.<Plan>create(config).buildSolver();
        Plan result=solver.solve(new Plan(p));
        var routes=new ArrayList<Map<String,Object>>();
        if(result.score.isFeasible()) for(var r:result.routes) {
            var w=r.worker; int at=Math.max(w.availableAt,w.shiftStart); String node=w.startLocationId;
            var visits=new ArrayList<Map<String,Object>>();
            for(var j:r.jobs) {
                at=Math.max(at+p.duration(w,node,j.locationId),Math.max(j.windowStart,j.releaseTime));
                visits.add(Bridge.visit(j,at)); at+=j.serviceDuration; node=j.locationId;
            }
            if(!visits.isEmpty()) routes.add(Bridge.route(w,Math.max(w.availableAt,w.shiftStart),visits));
        }
        var out=Bridge.result(p,routes,"2.6.0");
        if(!result.score.isFeasible()) out.put("status","NO_SOLUTION_FOUND");
        out.put("solverObjective",result.score.toString());
        out.put("rawDiagnostics",Map.of("nativeScore",result.score.toString(),"scoreModel","1 hard feasibility level; 3 lexicographic soft levels: coverage, workers, distance",
            "implementation","Community Edition; list variables allow unassigned jobs; earliest feasible schedule evaluated from every ordered route; generic easy score calculator"));
        return out;
    }
}
