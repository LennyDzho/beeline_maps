package research;

import com.google.gson.*;
import java.nio.file.*;
import java.util.*;

/** File-based local bridge. Original matrices and identifiers are never changed. */
public class Bridge {
    public static final Gson GSON = new GsonBuilder().setPrettyPrinting().create();
    public static class Job {
        @ai.timefold.solver.core.api.domain.common.PlanningId
        public String id;
        public String divisionId, requiredSkill, requiredTransportMode, locationId;
        public List<String> requiredQualifications = List.of(), requiredEquipment = List.of();
        public int windowStart, windowEnd, releaseTime, serviceDuration;
        public boolean isEmergency;
    }
    public static class Worker {
        public String id, divisionId, transportMode, startLocationId;
        public List<String> skills, qualifications = List.of(), equipment = List.of();
        public int shiftStart, shiftEnd, availableAt;
    }
    public static class Problem {
        public List<Job> jobs;
        public List<Worker> workers;
        public Map<String, Map<String, Map<String,Integer>>> travelTimeMatrices, distanceMatrices;
        public int arc(Worker w, String a, String b, boolean distance) {
            var source = (distance ? distanceMatrices : travelTimeMatrices).get(w.transportMode);
            var row = source.get(a);
            Integer val = row == null ? null : row.get(b);
            return val == null ? (distance ? 0 : 86401) : val;
        }
        public int duration(Worker w, String a, String b) {
            var dr = distanceMatrices.get(w.transportMode).get(a);
            if (dr == null || dr.get(b) == null) return 86401;
            return arc(w,a,b,false);
        }
        public boolean eligible(Worker w, Job j) {
            return w.divisionId.equals(j.divisionId) && w.skills.contains(j.requiredSkill)
                && (j.requiredTransportMode == null || j.requiredTransportMode.equals(w.transportMode))
                && w.qualifications.containsAll(j.requiredQualifications) && w.equipment.containsAll(j.requiredEquipment);
        }
        public long distanceUpper() {
            long max = 0;
            for (var m: distanceMatrices.values()) for (var r: m.values()) for (var d: r.values()) if(d!=null) max=Math.max(max,d);
            return max*jobs.size();
        }
    }
    public static Map<String,Object> visit(Job j, int start) {
        return Map.of("jobId",j.id,"start",start,"finish",start+j.serviceDuration);
    }
    public static Map<String,Object> route(Worker w, int departure, List<Map<String,Object>> visits) {
        return Map.of("workerId",w.id,"startLocationId",w.startLocationId,"departure",departure,"visits",visits);
    }
    public static Map<String,Object> result(Problem p, List<Map<String,Object>> routes, String version) {
        Set<String> assigned = new HashSet<>();
        for(var r: routes) for(var v: (List<Map<String,Object>>)r.get("visits")) assigned.add((String)v.get("jobId"));
        Map<String,Object> out = new LinkedHashMap<>();
        out.put("status","FEASIBLE"); out.put("routes",routes);
        out.put("unassigned",p.jobs.stream().map(j->j.id).filter(id->!assigned.contains(id)).toList());
        out.put("solverVersion",version); return out;
    }
    public static void main(String[] args) throws Exception {
        Problem p = GSON.fromJson(Files.readString(Path.of(args[1])),Problem.class);
        double limit = Double.parseDouble(args[3]); long seed = Long.parseLong(args[4]);
        long began=System.nanoTime();
        Map<String,Object> result = switch(args[0]) {
            case "jsprit" -> JspritAdapter.solve(p,limit,seed);
            case "timefold" -> TimefoldAdapter.solve(p,limit,seed);
            case "choco" -> ChocoAdapter.solve(p,limit,seed);
            default -> throw new IllegalArgumentException(args[0]);
        };
        result.put("runtime",Map.of("nativeWallTimeMs",(System.nanoTime()-began)/1e6));
        result.put("seed",seed);
        Files.writeString(Path.of(args[2]),GSON.toJson(result)+"\n");
    }
}
