package research;

import java.util.*;
import com.graphhopper.jsprit.core.problem.*;
import com.graphhopper.jsprit.core.problem.job.Service;
import com.graphhopper.jsprit.core.problem.vehicle.*;
import com.graphhopper.jsprit.core.problem.driver.Driver;
import com.graphhopper.jsprit.core.problem.cost.VehicleRoutingTransportCosts;
import com.graphhopper.jsprit.core.problem.solution.route.activity.TourActivity;
import com.graphhopper.jsprit.core.problem.solution.route.activity.TimeWindow;
import com.graphhopper.jsprit.core.algorithm.box.Jsprit;
import com.graphhopper.jsprit.core.algorithm.termination.TimeTermination;
import com.graphhopper.jsprit.core.algorithm.state.StateManager;
import com.graphhopper.jsprit.core.problem.constraint.*;
import com.graphhopper.jsprit.core.util.Solutions;

public class JspritAdapter {
    public static Map<String,Object> solve(Bridge.Problem p,double limit,long seed) {
        var wb=new HashMap<String,Bridge.Worker>(); var jb=new HashMap<String,Bridge.Job>();
        p.workers.forEach(w->wb.put(w.id,w)); p.jobs.forEach(j->jb.put(j.id,j));
        long fixed=p.distanceUpper()+1;
        long drop=p.workers.size()*fixed+p.distanceUpper()+1;
        if ((double)p.jobs.size()*drop+p.workers.size()*fixed+p.distanceUpper()>=Math.pow(2,52)) throw new IllegalArgumentException("Exact scalar exceeds double integer precision");
        var transport=new VehicleRoutingTransportCosts() {
            Bridge.Worker worker(Vehicle v) { return v==null ? p.workers.getFirst() : wb.get(v.getId()); }
            public double getTransportCost(Location a,Location b,double t,Driver d,Vehicle v) { return p.arc(worker(v),a.getId(),b.getId(),true); }
            public double getBackwardTransportCost(Location a,Location b,double t,Driver d,Vehicle v) { return getTransportCost(a,b,t,d,v); }
            public double getTransportTime(Location a,Location b,double t,Driver d,Vehicle v) { return p.duration(worker(v),a.getId(),b.getId()); }
            public double getBackwardTransportTime(Location a,Location b,double t,Driver d,Vehicle v) { return getTransportTime(a,b,t,d,v); }
            public double getDistance(Location a,Location b,double t,Vehicle v) { return p.arc(worker(v),a.getId(),b.getId(),true); }
        };
        var builder=VehicleRoutingProblem.Builder.newInstance().setFleetSize(VehicleRoutingProblem.FleetSize.FINITE).setRoutingCost(transport);
        for(var w:p.workers) {
            // Unique type retains every heterogeneous worker, even if starts coincide.
            var type=VehicleTypeImpl.Builder.newInstance(w.id).setFixedCost(fixed).setCostPerDistance(1).setCostPerTransportTime(0).build();
            var vehicle=VehicleImpl.Builder.newInstance(w.id).setType(type).setStartLocation(Location.newInstance(w.startLocationId))
                .setReturnToDepot(false).setEarliestStart(Math.max(w.availableAt,w.shiftStart)).setLatestArrival(w.shiftEnd);
            for(var j:p.jobs) if(p.eligible(w,j)) vehicle.addSkill(j.id);
            builder.addVehicle(vehicle.build());
        }
        for(var j:p.jobs) {
            int lower=Math.max(j.windowStart,j.releaseTime);
            if(lower>j.windowEnd) continue;
            builder.addJob(Service.Builder.newInstance(j.id).setLocation(Location.newInstance(j.locationId)).setServiceTime(j.serviceDuration)
                .setTimeWindow(TimeWindow.newInstance(lower,j.windowEnd)).addRequiredSkill(j.id).build());
        }
        var model=builder.build();
        var states=new StateManager(model);
        var constraints=new ConstraintManager(model,states);
        // Native progressive fixed-cost weighting undercounts early activations.
        // The exact cost of opening a route is constant throughout insertion.
        constraints.addConstraint((SoftRouteConstraint)ctx->ctx.getRoute().isEmpty()?fixed:0.0);
        // Explicit full-route feasibility is needed for open-route shift ends.
        // The insertion hook checks the prospective vehicle and complete order.
        constraints.addConstraint((HardActivityConstraint)(ctx,prev,newAct,next,departure)->{
            var w=wb.get(ctx.getNewVehicle().getId());
            List<TourActivity> sequence=new ArrayList<>(ctx.getRoute().getActivities());
            int pos=sequence.indexOf(prev)+1;
            sequence.add(pos,newAct);
            int at=Math.max(w.availableAt,w.shiftStart); String node=w.startLocationId;
            for(var act:sequence) {
                var j=jb.get(((TourActivity.JobActivity)act).getJob().getId());
                if(!p.eligible(w,j)) return HardActivityConstraint.ConstraintsStatus.NOT_FULFILLED;
                at=Math.max(at+p.duration(w,node,j.locationId),Math.max(j.windowStart,j.releaseTime));
                if(at>j.windowEnd || at+j.serviceDuration>w.shiftEnd) return HardActivityConstraint.ConstraintsStatus.NOT_FULFILLED;
                at+=j.serviceDuration; node=j.locationId;
            }
            return HardActivityConstraint.ConstraintsStatus.FULFILLED;
        },ConstraintManager.Priority.CRITICAL);
        var algorithm=Jsprit.Builder.newInstance(model).setRandom(new Random(seed)).setProperty(Jsprit.Parameter.THREADS,"1")
            .setProperty(Jsprit.Parameter.FIXED_COST_PARAM,"0.0").setStateAndConstraintManager(states,constraints)
            .setObjectiveFunction(solution->{
                double objective=solution.getUnassignedJobs().size()*drop+solution.getRoutes().size()*fixed;
                for(var route:solution.getRoutes()) {
                    String prev=route.getStart().getLocation().getId(); var w=wb.get(route.getVehicle().getId());
                    for(var activity:route.getActivities()) {
                        objective+=p.arc(w,prev,activity.getLocation().getId(),true); prev=activity.getLocation().getId();
                    }
                }
                return objective;
            }).buildAlgorithm();
        algorithm.setMaxIterations(Integer.MAX_VALUE);
        var termination=new TimeTermination(Math.max(1,Math.round(limit*1000)));
        algorithm.addTerminationCriterion(termination); algorithm.addListener(termination);
        var nativeResult=Solutions.bestOf(algorithm.searchSolutions());
        var routes=new ArrayList<Map<String,Object>>();
        if(nativeResult!=null) for(var nr:nativeResult.getRoutes()) {
            var w=wb.get(nr.getVehicle().getId()); var visits=new ArrayList<Map<String,Object>>();
            int at=Math.max(w.availableAt,w.shiftStart); String node=w.startLocationId;
            for(var activity:nr.getActivities()) {
                var j=jb.get(((TourActivity.JobActivity)activity).getJob().getId());
                int start=Math.max(at+p.duration(w,node,j.locationId),Math.max(j.windowStart,j.releaseTime));
                visits.add(Bridge.visit(j,start));
                at=start+j.serviceDuration; node=j.locationId;
            }
            if(!visits.isEmpty()) routes.add(Bridge.route(w,Math.max(w.availableAt,w.shiftStart),visits));
        }
        var out=Bridge.result(p,routes,"2.0.0");
        if(nativeResult==null) out.put("status","NO_SOLUTION_FOUND");
        else out.put("solverObjective",nativeResult.getCost());
        out.put("rawDiagnostics",Map.of("activationWeight",fixed,"dropWeight",drop,"distanceUpperBoundMetres",p.distanceUpper(),"seedScope","java.util.Random used by jsprit; one thread","returnToDepot",false));
        return out;
    }
}
