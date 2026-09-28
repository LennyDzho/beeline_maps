package research;

import java.util.*;
import org.chocosolver.solver.*;
import org.chocosolver.solver.variables.*;
import org.chocosolver.solver.search.strategy.Search;

/** Arc-flow CP reference. True lexicographic stages avoid 32-bit scalar overflow. */
public class ChocoAdapter {
    record Arc(int worker,int from,int to,BoolVar var,int distance) {}
    static void sum(Model m,List<BoolVar> xs,IntVar target) {
        if(xs.isEmpty()) m.arithm(target,"=",0).post();
        else m.sum(xs.toArray(IntVar[]::new),"=",target).post();
    }
    public static Map<String,Object> solve(Bridge.Problem p,double limit,long seed) {
        long began=System.nanoTime();
        // Compact-table substitution can allocate a bitset over the entire
        // distance domain. Keep equivalent arithmetic propagation instead.
        Model m=new Model("TRSP reference",SettingsBuilder.init().setEnableTableSubstitution(false));
        int n=p.jobs.size(),nw=p.workers.size();
        if(p.distanceUpper()>=Integer.MAX_VALUE/2) throw new IllegalArgumentException("Choco distance domain exceeds safe int range");
        IntVar[] times=new IntVar[n]; BoolVar[] used=m.boolVarArray("used",nw);
        for(int j=0;j<n;j++) {
            var job=p.jobs.get(j); int lower=Math.max(job.windowStart,job.releaseTime);
            times[j]=m.intVar("start_"+j,lower,Math.max(lower,job.windowEnd),true);
        }
        List<List<BoolVar>> byJob=new ArrayList<>();
        for(int j=0;j<n;j++) byJob.add(new ArrayList<>());
        List<BoolVar> ys=new ArrayList<>(); List<Arc> arcs=new ArrayList<>();
        for(int wi=0;wi<nw;wi++) {
            var w=p.workers.get(wi); int av=Math.max(w.availableAt,w.shiftStart);
            Map<Integer,BoolVar> y=new LinkedHashMap<>();
            Map<Integer,List<BoolVar>> incoming=new HashMap<>(),outgoing=new HashMap<>();
            for(int j=0;j<n;j++) {
                var job=p.jobs.get(j);
                if(!p.eligible(w,job) || times[j].getLB()>job.windowEnd || times[j].getLB()+job.serviceDuration>w.shiftEnd) continue;
                var assigned=m.boolVar("assigned_"+wi+"_"+j); y.put(j,assigned); ys.add(assigned); byJob.get(j).add(assigned);
                incoming.put(j,new ArrayList<>()); outgoing.put(j,new ArrayList<>());
                m.ifThen(assigned,m.arithm(times[j],"<=",w.shiftEnd-job.serviceDuration));
            }
            List<BoolVar> source=new ArrayList<>(),sink=new ArrayList<>();
            for(int j:y.keySet()) {
                var job=p.jobs.get(j); int travel=p.duration(w,w.startLocationId,job.locationId);
                if(av+travel<=times[j].getUB()) {
                    var x=m.boolVar("source_"+wi+"_"+j); source.add(x); incoming.get(j).add(x);
                    arcs.add(new Arc(wi,-1,j,x,p.arc(w,w.startLocationId,job.locationId,true)));
                    m.ifThen(x,m.arithm(times[j],">=",av+travel));
                }
                var end=m.boolVar("sink_"+wi+"_"+j); sink.add(end); outgoing.get(j).add(end); arcs.add(new Arc(wi,j,-2,end,0));
            }
            for(int i:y.keySet()) for(int j:y.keySet()) if(i!=j) {
                var a=p.jobs.get(i); var b=p.jobs.get(j); int travel=p.duration(w,a.locationId,b.locationId);
                int delta=a.serviceDuration+travel;
                if(times[i].getLB()+delta>times[j].getUB()) continue;
                var x=m.boolVar("arc_"+wi+"_"+i+"_"+j); outgoing.get(i).add(x); incoming.get(j).add(x);
                arcs.add(new Arc(wi,i,j,x,p.arc(w,a.locationId,b.locationId,true)));
                // Positive service times forbid disconnected cycles, with no big-M.
                m.ifThen(x,m.arithm(times[i],"-",times[j],"<=",-delta));
            }
            sum(m,source,used[wi]); sum(m,sink,used[wi]);
            for(int j:y.keySet()) { sum(m,incoming.get(j),y.get(j)); sum(m,outgoing.get(j),y.get(j)); }
        }
        for(var candidates:byJob) if(!candidates.isEmpty()) m.sum(candidates.toArray(IntVar[]::new),"<=",1).post();
        IntVar unassigned=m.intVar("unassigned",0,n),active=m.intVar("workers",0,nw),distance=m.intVar("distance",0,(int)p.distanceUpper(),true);
        List<IntVar> count=new ArrayList<>(ys); count.add(unassigned); m.sum(count.toArray(IntVar[]::new),"=",n).post();
        m.sum(used,"=",active).post();
        if(arcs.isEmpty()) m.arithm(distance,"=",0).post();
        else m.scalar(arcs.stream().map(Arc::var).toArray(IntVar[]::new),arcs.stream().mapToInt(Arc::distance).toArray(),"=",distance).post();
        long built=System.nanoTime(),deadline=built+(long)(limit*1e9);
        Solver solver=m.getSolver();
        Solution best=null; boolean proven=false;
        List<Map<String,Object>> stages=new ArrayList<>();
        IntVar[] objectives={unassigned,active,distance};
        for(int level=0;level<3;level++) {
            if(System.nanoTime()>=deadline) break;
            solver.reset(); m.clearObjective();
            solver.addStopCriterion(()->System.nanoTime()>=deadline);
            if(arcs.isEmpty()) solver.setSearch(Search.inputOrderLBSearch(objectives[level]),Search.inputOrderLBSearch(times));
            else solver.setSearch(Search.inputOrderLBSearch(objectives[level]), Search.domOverWDegSearch(arcs.stream().map(Arc::var).toArray(IntVar[]::new)), Search.inputOrderLBSearch(times));
            Solution found=solver.findOptimalSolution(objectives[level],false);
            if(found!=null) best=found;
            boolean optimal=solver.isObjectiveOptimal();
            Map<String,Object> stage=new LinkedHashMap<>();
            stage.put("level",level); stage.put("proven",optimal); stage.put("nodes",solver.getNodeCount());
            stage.put("incumbent",found==null?null:found.getIntVal(objectives[level]));
            stages.add(stage);
            if(found==null || !optimal) break;
            if(level==2) { proven=true; break; }
            int optimum=found.getIntVal(objectives[level]);
            solver.reset(); m.clearObjective(); m.arithm(objectives[level],"=",optimum).post();
        }
        List<Map<String,Object>> routes=new ArrayList<>();
        if(best!=null) for(int wi=0;wi<nw;wi++) {
            var w=p.workers.get(wi); Map<Integer,Integer> next=new HashMap<>();
            for(var a:arcs) if(a.worker==wi && best.getIntVal(a.var)==1) next.put(a.from,a.to);
            if(!next.containsKey(-1)) continue;
            List<Map<String,Object>> visits=new ArrayList<>(); int node=next.get(-1),guard=0;
            while(node!=-2) {
                if(++guard>n || !next.containsKey(node)) throw new IllegalStateException("Broken native route");
                visits.add(Bridge.visit(p.jobs.get(node),best.getIntVal(times[node]))); node=next.get(node);
            }
            routes.add(Bridge.route(w,Math.max(w.availableAt,w.shiftStart),visits));
        }
        var out=Bridge.result(p,routes,"6.0.1");
        out.put("status",best==null?"NO_SOLUTION_FOUND":proven?"OPTIMAL":"FEASIBLE");
        if(best!=null) out.put("solverObjective",List.of(best.getIntVal(unassigned),best.getIntVal(active),best.getIntVal(distance)));
        out.put("rawDiagnostics",Map.of("lexicographicStages",stages,"arcVariables",arcs.size(),"modelBuildTimeMs",(built-began)/1e6,
            "seedScope","Deterministic single-thread search; seed is repetition ID only","formulation","Reified time precedence, positive services eliminate cycles; same budget shared by three exact lexicographic stages"));
        return out;
    }
}
