"""Descriptive evidence summaries; never average different experiment conditions."""
import csv
import json
import statistics
from collections import Counter, defaultdict


ATTEMPT_METRICS = {
    "validPlanReturnedPercent", "fullCoverageReturnedPercent", "hardViolations", "solverWallTimeMs",
    "validationTimeMs", "processWallTimeMs", "peakMemoryMb", "cpuTimeSampledMs",
}


def aggregate_rows(rows, metrics, dimensions):
    groups = defaultdict(list)
    for row in rows:
        groups[tuple(row.get(key) for key in dimensions)].append(row)
    output = []
    for config, group in sorted(groups.items(), key=lambda item: str(item[0])):
        for metric in metrics:
            values = [r[metric] for r in group if r.get(metric) is not None
                      and (r.get("eligibleForComparison") or metric in ATTEMPT_METRICS)]
            if not values:
                continue
            output.append({**dict(zip(dimensions, config)), "metric": metric,
                "attempts": len(group), "validPlans": sum(bool(r.get("eligibleForComparison")) for r in group),
                "n": len(values), "minimum": min(values), "median": statistics.median(values),
                "maximum": max(values), "mean": statistics.mean(values),
                "sampleStd": statistics.stdev(values) if len(values) > 1 else None})
    return output


def primary_key(row):
    return (-row["served"], row["workersUsed"], row["distanceKm"])


def policy_key(row):
    if row["policy"] == "PRIMARY":
        return primary_key(row)
    # Mean response alone is insufficient when the number of emergencies differs.
    delay_sum = row.get("responseDelaySumSeconds")
    if delay_sum is None:
        delay_sum = round((row.get("meanResponseDelay") or 0) * row["emergencyServed"] * 60)
    leading = (-row["served"], -row["emergencyServed"])
    if row["policy"] == "POLICY_FAST_RESPONSE":
        return (*leading, delay_sum, row["workersUsed"], row["distanceKm"])
    return (*leading, row["workersUsed"], delay_sum, row["distanceKm"])


def plan_summaries(rows, dimensions, key=primary_key):
    groups = defaultdict(list)
    for row in rows:
        groups[tuple(row.get(k) for k in dimensions)].append(row)
    result = []
    for config, group in sorted(groups.items(), key=lambda item: str(item[0])):
        valid = sorted((r for r in group if r.get("eligibleForComparison")), key=key)
        result.append({**dict(zip(dimensions, config)), "attempts": len(group),
            "validPlans": len(valid), "statuses": dict(Counter(r["status"] for r in group)),
            "bestPlan": valid[0] if valid else None,
            "medianPlan": valid[len(valid)//2] if valid else None,
            "worstValidPlan": valid[-1] if valid else None})
    return result


def write_evidence(path, rows):
    path.with_suffix(".json").write_text(json.dumps(rows, ensure_ascii=False, indent=2)+"\n", encoding="utf-8")
    if rows:
        keys = list(dict.fromkeys(key for row in rows for key in row))
        with path.with_suffix(".csv").open("w", encoding="utf-8-sig", newline="") as f:
            writer = csv.DictWriter(f, fieldnames=keys)
            writer.writeheader()
            writer.writerows(rows)
