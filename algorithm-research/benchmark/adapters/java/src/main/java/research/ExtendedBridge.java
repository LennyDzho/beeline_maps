package research;

import com.google.gson.*;
import java.nio.file.*;
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

/** Separate model for policies and protected replanning; static baseline unchanged. */
public class ExtendedBridge {
    public static class Fixed { public String jobId,workerId; public int start,finish; }
    public static class Visit { public String jobId; public int start,finish; }
    public static class PreviousRoute { public String workerId; public List<Visit> visits; }
    public static class Previous { public List<PreviousRoute> routes; }
    public static class Problem extends Bridge.Problem {
        public List<Fixed> fixedActivities=new ArrayList<>(),protectedActivities=new ArrayList<>();
        public List<JsonObject> pastActivities=new ArrayList<>();
        public Previous previousSolution;
        public Integer eventAt;
        public transient String policy;
        public transient Map<String,Fixed> fixed=new HashMap<>();
        public transient Set<String> pastWorkers=new HashSet<>();
        public void prepare(String policy) {
            this.policy=policy;
            for(var f:fixedActivities) fixed.put(f.jobId,f);
            for(var f:protectedActivities) fixed.put(f.jobId,f);
            for(var a:pastActivities) pastWorkers.add(a.get("workerId").getAsString());
        }
    }
    @PlanningEntity
    public static class Route {
        @PlanningId public String id;
        public Bridge.Worker worker;
        @PlanningListVariable(valueRangeProviderRefs={"jobs"},allowsUnassignedValues=true)
        public List<Bridge.Job> jobs=new ArrayList<>();
        public Route() {}
        public Route(Bridge.Worker worker) { this.id=worker.id; this.worker=worker; }
    }
    @PlanningSolution
    public static class Plan {
        @ProblemFactProperty public Problem problem;
        @ProblemFactCollectionProperty @ValueRangeProvider(id="jobs") public List<Bridge.Job> jobs;
        @PlanningEntityCollectionProperty public List<Route> routes;
        @PlanningScore(bendableHardLevelsSize=1,bendableSoftLevelsSize=5) public BendableScore score;
        public Plan() {}
        public Plan(Problem p) { problem=p; jobs=p.jobs; routes=new ArrayList<>(); p.workers.forEach(w->routes.add(new Route(w))); }
    }
    record Scheduled(long hard,long distance,long delay,long emergencies,List<Map<String,Object>> visits) {}
    static Scheduled schedule(Problem p,Route r) {
        var w=r.worker;
        int at=Math.max(Math.max(w.availableAt,w.shiftStart),p.eventAt==null?0:p.eventAt);
        String node=w.startLocationId; long hard=0,distance=0,delay=0,emergencies=0;
        var visits=new ArrayList<Map<String,Object>>();
        for(var j:r.jobs) {
            if(!p.eligible(w,j)) hard++;
            int start=Math.max(at+p.duration(w,node,j.locationId),Math.max(j.windowStart,j.releaseTime));
            Fixed fixed=p.fixed.get(j.id);
            if(fixed!=null) {
                if(!fixed.workerId.equals(w.id)) hard++;
                hard+=Math.max(0,start-fixed.start)+Math.abs(fixed.finish-fixed.start-j.serviceDuration);
                start=fixed.start;
            }
            hard+=Math.max(0,start-j.windowEnd);
            hard+=Math.max(0,Math.max(j.windowStart,j.releaseTime)-start);
            at=start+j.serviceDuration;
            hard+=Math.max(0,at-w.shiftEnd);
            distance+=p.arc(w,node,j.locationId,true);
            if(j.isEmergency) { emergencies++; delay+=start-j.releaseTime; }
            visits.add(Bridge.visit(j,start)); node=j.locationId;
        }
        return new Scheduled(hard,distance,delay,emergencies,visits);
    }
    public static class Score implements EasyScoreCalculator<Plan,BendableScore> {
        public BendableScore calculateScore(Plan plan) {
            var p=plan.problem; long hard=0,distance=0,delay=0,emergencies=0,served=0;
            Set<String> assigned=new HashSet<>(),used=new HashSet<>(p.pastWorkers);
            for(var route:plan.routes) {
                var s=schedule(p,route); hard+=s.hard; distance+=s.distance; delay+=s.delay; emergencies+=s.emergencies;
                served+=route.jobs.size(); route.jobs.forEach(j->assigned.add(j.id));
                if(!route.jobs.isEmpty()) used.add(route.id);
            }
            for(String id:p.fixed.keySet()) if(!assigned.contains(id)) hard++;
            long missing=p.jobs.size()-served,missingEmergencies=p.jobs.stream().filter(j->j.isEmergency).count()-emergencies;
            long[] soft=switch(p.policy) {
                case "POLICY_FAST_RESPONSE" -> new long[]{-missing,-missingEmergencies,-delay,-used.size(),-distance};
                case "POLICY_MIN_STAFF" -> new long[]{-missing,-missingEmergencies,-used.size(),-delay,-distance};
                default -> new long[]{-missing,0,-used.size(),0,-distance};
            };
            return BendableScore.of(new long[]{-hard},soft);
        }
    }
    static Plan initial(Problem p) {
        var plan=new Plan(p); Map<String,Bridge.Job> jobs=new HashMap<>(); p.jobs.forEach(j->jobs.put(j.id,j));
        for(var route:plan.routes) {
            p.fixed.values().stream().filter(f->f.workerId.equals(route.id)).sorted(Comparator.comparingInt(f->f.start)).forEach(f->route.jobs.add(jobs.get(f.jobId)));
            if(p.previousSolution==null) continue;
            var previous=p.previousSolution.routes.stream().filter(r->r.workerId.equals(route.id)).findFirst();
            if(previous.isEmpty()) continue;
            List<Bridge.Job> warm=new ArrayList<>();
            for(var v:previous.get().visits) {
                var j=jobs.get(v.jobId); var f=p.fixed.get(v.jobId);
                if(j!=null && p.eligible(route.worker,j) && (f==null || f.workerId.equals(route.id))) warm.add(j);
            }
            var anchors=new ArrayList<>(route.jobs);
            if(warm.containsAll(anchors)) {
                var candidate=new Route(route.worker); candidate.jobs=warm;
                if(schedule(p,candidate).hard==0) route.jobs=warm;
            }
        }
        return plan;
    }
    public static void main(String[] args) throws Exception {
        Problem p=Bridge.GSON.fromJson(Files.readString(Path.of(args[0])),Problem.class);
        double limit=Double.parseDouble(args[2]); long seed=Long.parseLong(args[3]); p.prepare(args[4]);
        long began=System.nanoTime();
        var config=new SolverConfig().withSolutionClass(Plan.class).withEntityClasses(Route.class)
            .withEasyScoreCalculatorClass(Score.class).withRandomSeed(seed).withMoveThreadCount("NONE")
            .withTerminationSpentLimit(Duration.ofMillis(Math.max(1,Math.round(limit*1000))));
        Plan initial=initial(p);
        var result=SolverFactory.<Plan>create(config).buildSolver().solve(initial);
        var routes=new ArrayList<Map<String,Object>>();
        if(result.score.isFeasible()) for(var r:result.routes) {
            if(!r.jobs.isEmpty()) routes.add(Bridge.route(r.worker,Math.max(Math.max(r.worker.availableAt,r.worker.shiftStart),p.eventAt==null?0:p.eventAt),schedule(p,r).visits));
        }
        var out=Bridge.result(p,routes,"2.6.0");
        if(!result.score.isFeasible()) out.put("status","NO_SOLUTION_FOUND");
        out.put("pastActivities",p.pastActivities);
        out.put("seed",seed); out.put("solverObjective",result.score.toString());
        out.put("runtime",Map.of("nativeWallTimeMs",(System.nanoTime()-began)/1e6));
        out.put("rawDiagnostics",Map.of("variant","protected-policy-list-model","nativeScore",result.score.toString(),
            "protectedCount",p.fixed.size(),"warmStartRequested",p.previousSolution!=null,"initialAssigned",initial.routes.stream().mapToInt(r->r.jobs.size()).sum(),
            "scoreModel","One hard feasibility level; five exact lexicographic long levels; protected visits mandatory at exact worker/time"));
        Files.writeString(Path.of(args[1]),Bridge.GSON.toJson(out)+"\n");
    }
}
