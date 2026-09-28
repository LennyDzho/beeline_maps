"""Analytic tables/charts for actually executed policy and replanning runs."""
import csv
import json
from collections import defaultdict
from pathlib import Path
import statistics
import sys
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
from scripts.report_progress import METRICS as STATIC_METRICS
from scripts.report_statistics import ATTEMPT_METRICS,aggregate_rows,plan_summaries,policy_key,write_evidence
NAMES={"PRIMARY":"Первичный приоритет","POLICY_FAST_RESPONSE":"Быстрая реакция","POLICY_MIN_STAFF":"Минимальный штат"}
CASES={"initial":"Начальный план","new_emergency":"Новая авария","cancellation":"Отмена","worker_unavailability":"Недоступность бригады","manual_assignment":"Ручное назначение","manual_time":"Ручное время"}
METRICS={**STATIC_METRICS,"servedPercent":"Покрытие оставшейся очереди, %","workersUsed":"Бригад за весь день","distanceKm":"Пробег после события, км",
    "meanResponseDelay":"Средняя реакция аварий, мин","maxResponseDelay":"Максимальная реакция аварий, мин",
    "meanCompletionDelay":"Средняя задержка завершения аварий, мин","workerChanges":"Смена исполнителя",
    "orderChanges":"Изменение порядка","scheduleChanges":"Изменение времени","removedAssignments":"Снятые назначения",
    "newWorkersActivated":"Новые бригады относительно прежнего плана","maxScheduleShiftMinutes":"Максимальный сдвиг, мин",
    "injectedEmergencyResponseMinutes":"Реакция на единственную новую аварию, мин"}


def main():
    problem=json.loads((ROOT/"datasets/problem.json").read_text(encoding="utf-8"))
    latest={}
    for path in (ROOT/"results/raw").glob("policy-*.json"):
        r=json.loads(path.read_text(encoding="utf-8"))
        if r["datasetVersion"]!=problem["datasetVersion"] or r["matrixVersion"]!=problem["matrixVersion"]:continue
        key=(r["solver"],r["scope"],r["policy"],r["timeLimitSec"],r["seed"])
        if key not in latest or r["timestamp"]>latest[key]["timestamp"]: latest[key]={**r,"rawFile":str(path.relative_to(ROOT))}
    rows=[]
    for r in latest.values():
        m=r.get("metrics") or {}; s=r.get("solution") or {}
        row={k:r.get(k) for k in ["solver","scope","policy","timeLimitSec","seed","status","rawFile","datasetVersion","matrixVersion","adapterVersion","timestamp"]}
        row.update({k:m.get(k) for k in ["jobsTotal","emergencyTotal","committedJobs","wholeDayServed","reassignments",*METRICS]})
        row["jobsTotal"]=r["preflight"]["jobsTotal"]
        row.update({k:s.get(k,r.get(k)) for k in ["solverVersion","bestBound","optimalityGap"]})
        row["solverWallTimeMs"]=s.get("runtime",{}).get("solverWallTimeMs")
        row.update({k:r.get("resources",{}).get(k) for k in ["processWallTimeMs","peakMemoryMb","cpuTimeSampledMs"]})
        row["injectedEmergencyResponseMinutes"]=next((e["responseDelaySeconds"]/60 for e in m.get("emergencies",[]) if e["jobId"]=="synthetic-event-emergency" and e["served"]),None)
        row["responseDelaySumSeconds"]=sum(e["responseDelaySeconds"] for e in m.get("emergencies",[]) if e["served"]) if m.get("eligibleForComparison") else None
        row["eligibleForComparison"]=m.get("eligibleForComparison",False)
        row["validPlanReturnedPercent"]=100 if row["eligibleForComparison"] else 0
        row["fullCoverageReturnedPercent"]=100 if row["eligibleForComparison"] and row["served"]==row["jobsTotal"] else 0
        rows.append(row)
    (ROOT/"results/policy_results.json").write_text(json.dumps(rows,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
    if not rows:return
    write_evidence(ROOT/"results/policy_aggregate_metrics",aggregate_rows(rows,METRICS,["solver","scope","policy","timeLimitSec"]))
    (ROOT/"results/policy_plan_summary.json").write_text(json.dumps(plan_summaries(rows,["solver","scope","policy","timeLimitSec"],policy_key),ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
    with (ROOT/"results/policy_results.csv").open("w",encoding="utf-8-sig",newline="") as f:
        writer=csv.DictWriter(f,fieldnames=list(rows[0])); writer.writeheader(); writer.writerows(rows)
    folder="dynamic-hd-v2" if problem.get("competencyModel") else "dynamic-v1"
    manifest=json.loads((ROOT/f"datasets/{folder}/manifest.json").read_text(encoding="utf-8"))
    committed=manifest["scenarios"][0]["committedActivities"]
    text=["# Аварийные политики и перепланирование", "", "Значения относятся к конкретным реализациям и имеющимся повторам; завершённость всей сетки указана в основном отчёте.", "",
        f"Все динамические случаи используют один заранее замороженный начальный план OR-Tools Routing, а не собственные разные планы кандидатов. Момент события — 11:00. {committed} завершённых/начатых действий неизменны; уже выехавший исполнитель освобождается в месте завершения защищённой работы. Три будущих клиентских визита защищены. В ручных событиях дополнительно фиксируются новый исполнитель или время. [Манифест сценариев](../datasets/{folder}/manifest.json).", "",
        "Покрытие считается по оставшейся очереди, штат — за весь день с учётом фиксированной части. Пробег и перемещения — только после события; они не выдаются за полный дневной пробег. Средняя реакция включает все оставшиеся аварии с их исходным временем появления. Реакция на единственную новую аварию выделена отдельно. Старые завершённые работы не считаются снятыми назначениями.", "",
        "| Метод | Сценарий | Политика | Бюджет/seed | Статус | Назначено | Бригад | Реакция, средняя мин | Новая авария, мин | Нарушения |", "|---|---|---|---|---|---:|---:|---:|---:|---:|"]
    def fmt(x):return "—" if x is None else f"{x:.2f}" if isinstance(x,float) else str(x)
    for row in sorted(rows,key=lambda r:(r["solver"],r["scope"],r["policy"],r["timeLimitSec"],r["seed"])):
        text.append(f"| {row['solver']} | {CASES[row['scope']]} | {NAMES[row['policy']]} | {row['timeLimitSec']:g}с / {row['seed']} | {row['status']} | {fmt(row['served'])}/{fmt(row['jobsTotal'])} | {fmt(row['workersUsed'])} | {fmt(row['meanResponseDelay'])} | {fmt(row['injectedEmergencyResponseMinutes'])} | {fmt(row['hardViolations'])} |")
    figure_dir=ROOT/"reports/figures";figure_dir.mkdir(exist_ok=True)
    for metric,label in METRICS.items():
        fig,ax=plt.subplots(figsize=(11,5.5),layout="constrained"); has=False
        cases=[c for c in CASES if c!="initial"]
        for solver,budget in sorted({(r["solver"],r["timeLimitSec"]) for r in rows}):
            for policy in NAMES:
                values=[]
                for case in cases:
                    group=[r[metric] for r in rows if r["solver"]==solver and r["timeLimitSec"]==budget and r["scope"]==case and r["policy"]==policy and (r["eligibleForComparison"] or metric in ATTEMPT_METRICS) and r[metric] is not None]
                    values.append((statistics.mean(group) if metric.endswith("ReturnedPercent") else statistics.median(group)) if group else float("nan"))
                if all(v!=v for v in values):continue
                ax.plot(range(len(cases)),values,marker="o",label=solver+f" · {budget:g}с · "+NAMES[policy]);has=True
        if not has:plt.close(fig);continue
        ax.set_xticks(range(len(cases)),[CASES[c].replace(" ","\n",1) for c in cases]);ax.set_title(label,loc="left")
        ax.set_ylim(bottom=0);ax.grid(axis="y",alpha=.2);ax.spines[["top","right"]].set_visible(False)
        ax.legend(frameon=False,loc="upper center",bbox_to_anchor=(.5,-.18),ncol=2,fontsize=8)
        fig.savefig(figure_dir/f"policy-{metric}.png",dpi=150);fig.savefig(figure_dir/f"policy-{metric}.svg");plt.close(fig)
        text += ["",f"## {label}","",f"![{label}](figures/policy-{metric}.png)"]
    text += ["", "Графики качества показывают медианы допустимых результатов; ресурсы, нарушения и доля допустимых возвратов учитывают все попытки. Доля возвратов — средняя, остальные кривые — медианы. Единственное наблюдение не измеряет устойчивость. Непроверенные адаптеры других кандидатов не объявляются неспособными поддержать эти функции.", "",
        "[Полная статистика mean/median/min/max/sampleStd](../results/policy_aggregate_metrics.json), [CSV статистики](../results/policy_aggregate_metrics.csv), [лучший, медианный и худший допустимый планы по цели конкретной политики](../results/policy_plan_summary.json). Разные события, политики и бюджеты не объединяются.", ""]
    (ROOT/"reports/POLICIES_AND_REPLANNING.md").write_text("\n".join(text),encoding="utf-8")
    print(json.dumps({"rows":len(rows),"valid":sum(r["eligibleForComparison"] for r in rows)}))


if __name__=="__main__":main()
