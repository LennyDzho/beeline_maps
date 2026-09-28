"""Build a self-contained analytic HTML report and matching Markdown from evidence.

Never joins different dataset revisions, ranks invalid solutions or invents
results for unimplemented cases. Run after report_progress/report_policies.
"""
import base64
import csv
import html
import json
import math
import re
import statistics
from collections import Counter,defaultdict
from datetime import datetime,timezone
from pathlib import Path
import sys
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
from scripts.report_progress import LABELS,METRICS,COLORS
from scripts.report_policies import CASES,NAMES,METRICS as DYNAMIC_METRICS
from scripts.report_statistics import ATTEMPT_METRICS,aggregate_rows,plan_summaries,write_evidence


def read(path,default=None):
    return json.loads((ROOT/path).read_text(encoding="utf-8")) if (ROOT/path).exists() else default


def save(path,value):
    (ROOT/path).write_text(json.dumps(value,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")


def fmt(value,digits=2):
    if value is None:return "—"
    if isinstance(value,bool):return "да" if value else "нет"
    if isinstance(value,float):return f"{value:,.{digits}f}".replace(","," ") if math.isfinite(value) else "—"
    return str(value)


def order(r):
    return (-r["served"],r["workersUsed"],r["distanceKm"])


def inline(text):
    value=html.escape(str(text))
    value=re.sub(r"\[([^\]]+)\]\(([^)]+)\)",r'<a href="\2">\1</a>',value)
    value=re.sub(r"\*\*([^*]+)\*\*",r'<strong>\1</strong>',value)
    value=re.sub(r"`([^`]+)`",r'<code>\1</code>',value)
    return value


class Document:
    def __init__(self):self.md=[];self.web=[];self.toc=[]
    def heading(self,text,level=2):
        anchor="report-title" if level==1 else "section-"+str(len(self.toc)+1)
        if level==2:self.toc.append((anchor,text))
        self.md += ["#"*level+" "+text,""];self.web.append(f'<h{level} id="{anchor}">{inline(text)}</h{level}>')
    def p(self,text):self.md += [text,""];self.web.append("<p>"+inline(text)+"</p>")
    def table(self,headers,rows):
        self.md += ["| "+" | ".join(headers)+" |","|"+"---|"*len(headers)]
        self.web.append('<div class="table"><table><thead><tr>'+"".join("<th>"+inline(h)+"</th>" for h in headers)+"</tr></thead><tbody>")
        for row in rows:
            values=[fmt(v) for v in row];self.md.append("| "+" | ".join(v.replace("|","/") for v in values)+" |")
            self.web.append("<tr>"+"".join("<td>"+inline(v)+"</td>" for v in values)+"</tr>")
        self.md.append("");self.web.append("</tbody></table></div>")
    def image(self,name,label):
        path=ROOT/"reports/figures"/name
        if not path.exists():return
        self.md += [f"![{label}](reports/figures/{name})",""]
        encoded=base64.b64encode(path.read_bytes()).decode()
        self.web.append(f'<figure><img alt="{html.escape(label)}" src="data:image/png;base64,{encoded}"><figcaption>{inline(label)}</figcaption></figure>')
    def write(self):
        (ROOT/"REPORT.md").write_text("\n".join(self.md),encoding="utf-8")
        css="body{font:16px/1.6 system-ui,sans-serif;background:#f3f5f7;color:#19252f;margin:0}main{max-width:1220px;margin:auto;padding:48px 40px;background:white}h1{font-size:38px;line-height:1.2;color:#10394f}h2{font-size:27px;margin-top:48px;border-top:1px solid #dce3e8;padding-top:24px}h3{font-size:20px;margin-top:32px}p{max-width:1000px}a{color:#006999}code{font-size:.85em;background:#eef2f4;padding:2px 5px;overflow-wrap:anywhere}.table{overflow-x:auto;margin:22px 0}table{border-collapse:collapse;width:100%;font-size:13px}th,td{text-align:left;vertical-align:top;border-bottom:1px solid #dce3e8;padding:9px 11px}th{background:#e8f0f4}tr:nth-child(even){background:#f6f8fa}figure{margin:28px 0;break-inside:avoid}img{width:100%;height:auto;max-width:1100px}figcaption{color:#52606b;font-size:13px}@media print{body{background:white}main{padding:0}h2{break-before:page}.table{overflow:visible}a{color:inherit}}"
        navigation='<nav aria-label="Содержание"><details><summary>Содержание отчёта</summary><ol>'+"".join(f'<li><a href="#{anchor}">{inline(title)}</a></li>' for anchor,title in self.toc)+"</ol></details></nav>"
        (ROOT/"REPORT.html").write_text('<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Марш! — исследование оптимизаторов</title><style>'+css+'</style><main>'+self.web[0]+navigation+"\n".join(self.web[1:])+"</main></html>",encoding="utf-8")


def scaling_rows(problem):
    latest={}
    for path in (ROOT/"results/raw").glob("scale-*.json"):
        r=json.loads(path.read_text(encoding="utf-8"))
        if r.get("sourceDatasetVersion")!=problem["datasetVersion"] or r["matrixVersion"]!=problem["matrixVersion"]:continue
        key=(r["solver"],r["scope"],r["timeLimitSec"],r["seed"])
        if key not in latest or r["timestamp"]>latest[key]["timestamp"]:latest[key]={**r,"rawFile":str(path.relative_to(ROOT))}
    rows=[]
    for r in latest.values():
        m=r.get("metrics") or {};s=r.get("solution") or {}
        row={k:r.get(k) for k in ["solver","scope","policy","timeLimitSec","seed","status","rawFile","datasetVersion","matrixVersion","adapterVersion","timestamp"]}
        row.update({k:m.get(k) for k in ["jobsTotal","emergencyTotal","eligibleForComparison",*METRICS]})
        row["jobsTotal"]=r["preflight"]["jobsTotal"]
        row["solverWallTimeMs"]=s.get("runtime",{}).get("solverWallTimeMs")
        row.update({k:s.get(k,r.get(k)) for k in ["solverVersion","bestBound","optimalityGap"]})
        row.update({k:r.get("resources",{}).get(k) for k in ["processWallTimeMs","peakMemoryMb","cpuTimeSampledMs","sampleCount","samplingIntervalMs","memoryGuardMiB","terminationReason"]})
        row["errorType"]=(r.get("error") or {}).get("type")
        row["errorMessage"]=(r.get("error") or {}).get("message")
        row["validPlanReturnedPercent"]=100 if row.get("eligibleForComparison") else 0
        row["fullCoverageReturnedPercent"]=100 if row.get("eligibleForComparison") and row["served"]==row["jobsTotal"] else 0
        rows.append(row)
    write_evidence(ROOT/"results/scaling_results",rows)
    write_evidence(ROOT/"results/scaling_aggregate_metrics",aggregate_rows(rows,METRICS,["solver","scope","policy","timeLimitSec"]))
    save("results/scaling_plan_summary.json",plan_summaries(rows,["solver","scope","policy","timeLimitSec"]))
    return rows


def scale_charts(rows,scale):
    if not scale:return
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    metrics={**METRICS,"fullCoverageWorkersUsed":"Бригад при полном покрытии","fullCoverageDistanceKm":"Пробег при полном покрытии, км"}
    data=[{**r,"jobsTotal":203} for r in rows if r["scope"]=="all"]+scale
    configurations=sorted({(r["solver"],r["timeLimitSec"]) for r in scale})
    for key,label in metrics.items():
        source_key={"fullCoverageWorkersUsed":"workersUsed","fullCoverageDistanceKm":"distanceKm"}.get(key,key)
        fig,ax=plt.subplots(figsize=(10.5,6.2),layout="constrained")
        for sid,budget in configurations:
            points=[]
            for size in [203,500,1000]:
                vals=[r.get(source_key) for r in data if r["solver"]==sid and r["timeLimitSec"]==budget and r["jobsTotal"]==size and r.get(source_key) is not None and (r.get("eligibleForComparison") or key in ATTEMPT_METRICS) and (key not in {"fullCoverageWorkersUsed","fullCoverageDistanceKm"} or r.get("served")==r["jobsTotal"])]
                if vals:points.append((size,statistics.mean(vals) if key.endswith("ReturnedPercent") else statistics.median(vals),min(vals),max(vals)))
            if points:
                ax.plot([v[0] for v in points],[v[1] for v in points],marker="o",color=COLORS[sid],linestyle="-" if budget==min(b for s,b in configurations if s==sid) else "--",label=LABELS[sid]+f" · {budget:g}с")
                if not key.endswith("ReturnedPercent"):ax.fill_between([v[0] for v in points],[v[2] for v in points],[v[3] for v in points],color=COLORS[sid],alpha=.1)
        ax.set_xticks([203,500,1000]);ax.set_xlabel("Число заявок; число бригад растёт пропорционально")
        ax.set_title(label,loc="left");ax.set_ylim(bottom=0);ax.grid(axis="y",alpha=.2);ax.spines[["top","right"]].set_visible(False)
        ax.legend(frameon=False,loc="upper center",bbox_to_anchor=(.5,-.14),ncol=3,fontsize=8)
        fig.savefig(ROOT/f"reports/figures/scaling-{key}.png",dpi=150);fig.savefig(ROOT/f"reports/figures/scaling-{key}.svg");plt.close(fig)


def full_coverage_charts(rows):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    data=[r for r in rows if r["scope"]=="all" and r["eligibleForComparison"] and r["served"]==r["jobsTotal"]]
    for key,label in [("workersUsed","Бригады при полном покрытии"),("distanceKm","Пробег при полном покрытии, км")]:
        fig,ax=plt.subplots(figsize=(10.5,5.7),layout="constrained")
        for sid in LABELS:
            groups=defaultdict(list)
            for r in data:
                if r["solver"]==sid:groups[r["timeLimitSec"]].append(r[key])
            if not groups:continue
            xs=sorted(groups);ax.plot(xs,[statistics.median(groups[x]) for x in xs],color=COLORS[sid],marker="o",label=LABELS[sid])
            ax.fill_between(xs,[min(groups[x]) for x in xs],[max(groups[x]) for x in xs],color=COLORS[sid],alpha=.1)
        budgets=sorted({r["timeLimitSec"] for r in rows if r["scope"]=="all"})
        ax.set_xscale("log");ax.set_xticks(budgets,[f"{b:g}" for b in budgets]);ax.set_title(label+" · 203/203 заявки",loc="left")
        ax.set_xlabel("Бюджет поиска, с (логарифмическая шкала)");ax.grid(axis="y",alpha=.2);ax.spines[["top","right"]].set_visible(False)
        ax.legend(frameon=False,loc="upper center",bbox_to_anchor=(.5,-.15),ncol=3,fontsize=9)
        fig.savefig(ROOT/f"reports/figures/primary-full-{key}.png",dpi=150);fig.savefig(ROOT/f"reports/figures/primary-full-{key}.svg");plt.close(fig)


def exact_comparison(rows):
    exact=[r for r in rows if r["scope"].startswith("exact-")]
    proofs={}
    for scope in sorted({r["scope"] for r in exact}):
        optimal=[r for r in exact if r["scope"]==scope and r["status"]=="OPTIMAL" and r["eligibleForComparison"]]
        if optimal:
            signatures={(r["served"],r["workersUsed"],round(r["distanceKm"]*1000)) for r in optimal}
            if len(signatures)!=1:
                raise ValueError(f"Conflicting independently validated optimality certificates for {scope}: {signatures}")
            proofs[scope]={"plan":optimal[0],"solvers":sorted({r["solver"] for r in optimal}),"rawFiles":[r["rawFile"] for r in optimal]}
    output=[]
    for r in exact:
        proof=proofs.get(r["scope"]);ref=proof["plan"] if proof else None
        row={k:r[k] for k in ["solver","scope","timeLimitSec","seed","status","rawFile"]}
        row.update(referenceRawFiles=proof["rawFiles"] if proof else [],matchesProvedOptimum=None,missedJobsVsOptimum=None,extraWorkersAtSameCoverage=None,extraDistanceKmAtSameCoverageAndStaff=None)
        if ref and r["eligibleForComparison"]:
            row["missedJobsVsOptimum"]=ref["served"]-r["served"]
            if r["served"]==ref["served"]:
                row["extraWorkersAtSameCoverage"]=r["workersUsed"]-ref["workersUsed"]
                if r["workersUsed"]==ref["workersUsed"]:
                    row["extraDistanceKmAtSameCoverageAndStaff"]=round(r["distanceKm"]-ref["distanceKm"],3)
            signature=lambda x:(-x["served"],x["workersUsed"],round(x["distanceKm"]*1000))
            if signature(r)<signature(ref):
                raise ValueError(f"Valid solution better than claimed optimum: {r['rawFile']}")
            row["matchesProvedOptimum"]=signature(r)==signature(ref)
        output.append(row)
    write_evidence(ROOT/"results/exact_reference_comparison",output)
    return proofs,output


def main():
    p=read("datasets/problem.json");rows=read("results/benchmark_results.json",[])
    rows=[r for r in rows if r["datasetVersion"]==p["datasetVersion"] and r["matrixVersion"]==p["matrixVersion"]]
    policies=read("results/policy_results.json",[])
    # Policy summary regeneration is mandatory after a dataset switch.
    raw_policy=[]
    for r in policies:
        source=read(r["rawFile"],{})
        if source.get("datasetVersion")==p["datasetVersion"] and source.get("matrixVersion")==p["matrixVersion"]:raw_policy.append(r)
    policies=raw_policy
    scale=scaling_rows(p);scale_charts(rows,scale);full_coverage_charts(rows);reg=read("registry/verified-registry.json",[])
    tests=read("results/test_matrix.json",[]);caps=read("results/capability_matrix.json",[]);complexity=read("results/integration_complexity.json",[])
    combined=[{"experiment":"static",**r} for r in rows]+[{"experiment":"dynamic",**r} for r in policies]+[{"experiment":"scaling",**r} for r in scale]
    for r in combined:
        integration=next((v for v in complexity if v["solver"]==r["solver"]),{})
        for key in ["adapterLOC","workaroundCount","unsupportedFeatureCount"]:r[key]=integration.get(key)
        r["commitSha"]=next((v.get("commitSha") for v in reg if v["id"]==r["solver"]),None)
    write_evidence(ROOT/"results/all_benchmark_results",combined)
    source_validation=json.loads((ROOT.parent/"datasets/beeline-hd-v2/validation.json").read_text(encoding="utf-8"))
    env=read("registry/environment.json",{})
    main_rows=[r for r in rows if r["scope"]=="all"]
    freeze=read("results/frozen-evidence.json",{})
    decision=read("results/final_analysis.json",{}) if freeze else {}
    stochastic={"ortools_routing","vroom","jsprit","pyvrp","timefold","alns"}
    planned={(sid,b,s) for sid in LABELS for b in [1,5,15,60,300] for s in (range(1,11) if sid in stochastic else [1])}
    actual={(r["solver"],r["timeLimitSec"],r["seed"]) for r in main_rows}
    missing=sorted(planned-actual);save("results/missing_main_runs.json",[{"solver":a,"budget":b,"seed":c} for a,b,c in missing])
    groups=defaultdict(list)
    for r in main_rows:groups[r["solver"],r["timeLimitSec"]].append(r)
    d=Document();d.heading("Марш! — сравнение методов распределения и маршрутизации",1)
    d.p("**Версия с точными квалификациями ВК/HD.** Отчёт сформирован "+datetime.now(timezone.utc).strftime("%d.%m.%Y %H:%M UTC")+f". На основном наборе сохранено {len(main_rows)} конфигураций, с подразделениями и малыми поднаборами — {len(rows)}; динамических — {len(policies)}, масштабных — {len(scale)}.")
    if freeze:
        d.p(f"**Итоговый отчёт по зафиксированным результатам.** Владелец остановил дальнейшие повторные запуски и поручил перейти к аналитике. На основном наборе сохранено {len(main_rows)} конфигураций на бюджетах 1/5/15/60/300 с. У шести эвристик по десять наблюдений при 1/5/15 с, при 60 с — по шесть или семь, при 300 с — по одному. Динамика и масштабирование представлены контрольными запусками. Недостающие части первоначального расширенного плана не являются текущей незавершённой работой и не заменены оценками. [Фиксация среза и SHA первичных результатов](results/frozen-evidence.json).")
    else:
        d.p(f"Статус основной сетки 1/5/15/60/300 с: **{len(planned & actual)}/{len(planned)}**. Для шести эвристических методов предусмотрено десять повторов на каждый бюджет, для четырёх точных/CP методов — по одному контролю с границами. "+("Сетка выполнена." if not missing else "Расчёты продолжаются; отсутствующие запуски не заменены оценками. Вывод ниже ограничен выполненной частью эксперимента."))
    if decision.get("executiveSummary"):
        d.heading("Решение по результатам сравнения")
        for paragraph in decision["executiveSummary"]:d.p(paragraph)
    d.heading("Что сравнивается")
    d.p("Сначала максимум выполненных заявок, затем минимум задействованных бригад, затем минимальный пробег. Для аварийных политик после покрытия добавляется максимум выполненных аварий; далее либо задержка реакции перед штатом (FAST_RESPONSE), либо штат перед задержкой (MIN_STAFF). Единого условного балла нет. Сравниваются внешние метрики после независимой проверки H01–H12, а не внутренние objective библиотек.")
    d.table(["Параметр","Зафиксированное значение"],[
        ["Исходная очередь","203 новые заявки; 35 бригад; Восток 66, Юго-восток 81, Югоцентр 56; переходы между подразделениями запрещены"],
        ["Транспорт и смена","Автомобиль у всех, без перерывов — указание владельца. 09:00–22:00 — явно синтетический горизонт, не утверждение о реальном трудовом графике"],
        ["Квалификации",f"{source_validation['hdCompetencyLinks']} связей бригада/ВК/HD, только из исторически назначавшихся работ. Все HD составной заявки обязательны; {source_validation['combinedHdJobs']} составных заявок остаются одним визитом каждая"],
        ["Начало маршрута","Свой офис из футера исходной таблицы; после события — актуальная точка и следующая доступность. Возврат в офис не требуется"],
        ["Окна и время работ","Внутри окна должно находиться начало, конец работы может быть позже окна, но внутри смены. Длительность BK: 70/80/20/30 минут; условные 20 минут дороги из норматива исключены"],
        ["Дорожные данные","Единая OSM/OSRM матрица после HTTP 429 у 2ГИС, без трафика. 206 узлов, 14 462 направленные пары, недостижимых пар нет"],
        ["Неопределённые адреса","Семь уникальных адресов / восемь узлов, включая два офиса, используют объявленные модельные привязки. Это не подтверждённые владельцем реальные координаты"],
        ["Начало аварии","Исходные заявки известны в 09:00 — синтетическое допущение. Аварией считается HD «Авария». Новая динамическая авария появляется в 11:00"],
        ["Проверка данных","Каждый запуск выполняет preflight до импорта/запуска решателя: поля, матрицы, времена, стартовые координаты, ВК/HD и их передача адаптеру, protected activities"]])
    d.p("Данные и алгоритмы MVP не изменялись. [Строгий датасет](../datasets/beeline-hd-v2/dataset.json), [бригады и их HD](../datasets/beeline-hd-v2/WORKERS.md), [проверки квалификаций](../datasets/beeline-hd-v2/validation.json), [разбор геокодирования](reports/GEOCODING_REVIEW.md). Начальные результаты с широкими категориями квалификаций сохранены [отдельно](reports/archive-coarse-v1/README.md): они не включены в эти агрегаты.")
    d.heading("Кандидаты, локальный запуск и лицензии")
    d.table(["Метод","Проверенная версия","Лицензия","API / семейство"],[[f"[{c['name']}]({c['repository']})",c.get("verifiedSolverVersion"),c["license"],c["api"]+" / "+c["family"]] for c in reg])
    d.p("Все десять установлены и запускались локально; обязательного облачного runtime нет. Используются только открытые компоненты. У Timefold многопоточный инкрементальный поиск и partitioned search относятся к Enterprise и здесь не используются: [официальная документация](https://docs.timefold.ai/timefold-solver/latest/running-timefold-solver/multithreaded-solving). Community достаточно для реализованной модели.")
    d.p("Версии установленных wheel/JAR/exe отделены от последних найденных релизов. В частности, pyvroom 1.15.2 не выдаётся за установленный C++ VROOM 1.15.0; commit ядра обёртки не подтверждён. SCIP установлен 10.0.2, даже если в реестре ссылок найден более свежий tag. SHA бинарников и JAR сохранены; неподтверждённый commitSha остаётся пустым. [Реестр](registry/verified-registry.json), [Java](registry/java-build.json), [CBC](registry/cbc-runtime.json), [lock Python](requirements/python-lock.txt), [лицензии и POM установленных компонентов с контрольными суммами](registry/license-evidence.json). Лицензии оболочек PySCIPOpt и PuLP отделены от лицензий ядер SCIP и CBC.")
    d.heading("Протокол измерения")
    d.p(f"Машина: {env.get('physicalCpuCount','—')} физических / {env.get('logicalCpuCount','—')} логических ядер, {fmt(env.get('totalMemoryBytes',0)/1024**3)} ГиБ RAM. Решатели выполняются последовательно. Новый Python-процесс на измерение, новая JVM у Java-методов, 2 ГиБ heap. Суммарная RSS процесса и потомков, CPU и полное время измеряются с шагом 50 мс. Это рабочий компьютер пользователя, без гарантии фиксированной частоты CPU или отсутствия фоновых приложений.")
    d.p("Бюджет — время поиска библиотеки; ALNS включает построение начального состояния, CBC использует CPU limit. Построение модели, запуск JVM и импорт библиотек могут увеличить полное wall time. Общий watchdog ограничивает зависания; процесс останавливается при суммарной RSS более 6 ГиБ. Эти остановки являются ограничением экспериментальной среды, а не доказательством невозможности задачи. Пик RSS измерен выборками, короткие процессы между выборками могут дать недооценку CPU.")
    d.p("Для одной конфигурации берётся последняя попытка текущей версии данных; прошлые raw сохраняются. В таблице медианы качества показан один реальный план в середине лексикографически отсортированных допустимых результатов. Средние отдельных метрик публикуются отдельно и не изображаются как реально существующий маршрут. В OR-Tools Routing, VROOM и выбранной конфигурации Choco повтор не означает доказанное управление случайностью поиска через seed.")
    d.heading("Результаты основного набора")
    summary=[]
    for (sid,budget),group in sorted(groups.items()):
        valid=sorted([r for r in group if r["eligibleForComparison"]],key=order);r=valid[len(valid)//2] if valid else group[-1]
        summary.append([LABELS[sid],budget,f"{len(valid)}/{len(group)}",r["seed"],r["status"],r.get("served"),r.get("workersUsed"),r.get("distanceKm"),r.get("meanResponseDelay"),(r.get("processWallTimeMs") or r.get("solverWallTimeMs") or 0)/1000])
    d.table(["Метод","Бюджет, с","Допустимо/всего","Seed","Статус","Заявки","Бригады","км","Реакция, мин","Полное время, с"],summary)
    d.p("Пустой план имеет нулевой пробег, но уступает любому допустимому плану с назначенной работой. NO_SOLUTION_FOUND означает отсутствие найденного допустимого incumbent; ненайденное решение не доказывает невозможность. В PRIMARY задержка аварий измеряется, но не является отдельным приоритетом оптимизации.")
    d.p("Следующие два графика показывают только планы с 203 из 203 заявок. Сначала сравнивается штат; пробег — после него. Доля успешных возвратов и все частичные планы остаются в основной таблице, поэтому отбор по полному покрытию не скрывает неуспешные попытки.")
    d.image("primary-full-workersUsed.png","Бригады при полном покрытии")
    d.image("primary-full-distanceKm.png","Пробег при полном покрытии")
    d.heading("Графики по метрикам")
    d.p("Линии — медианы, полупрозрачные диапазоны — min–max повторов. Доли возврата допустимого плана и полного покрытия считаются по всем попыткам, включая ошибки и отсутствие решения. Допустимый частичный или пустой план не считается полным покрытием. Штат, пробег и задержки следует сопоставлять только после покрытия; значения пустых планов не являются преимуществом. Метрики времени и ресурсов не сводятся к внутренним objective.")
    for metric,label in METRICS.items():d.image(f"baseline-{metric}.png",label)
    d.heading("Устойчивость и суммарные показатели")
    stability=[]
    for (sid,budget),group in sorted(groups.items()):
        valid=sorted([r for r in group if r["eligibleForComparison"]],key=order)
        if not valid:continue
        best,median,worst=valid[0],valid[len(valid)//2],valid[-1]
        plan=lambda r:f"{r['served']} / {r['workersUsed']} / {r['distanceKm']:.3f}"
        stability.append([LABELS[sid],budget,len(group),plan(best),plan(median),plan(worst),statistics.mean(r["workersUsed"] for r in valid),statistics.stdev(r["workersUsed"] for r in valid) if len(valid)>1 else None])
    d.table(["Метод","с","Повторов","Лучший: заявки/бригады/км","Медианный план","Худший допустимый","Средний штат","Std штата"],stability)
    d.p("Полные mean/median/min/max/sampleStd для каждой метрики и конфигурации: [агрегаты JSON](results/aggregate_metrics.json). Все строки и параметры: [CSV](results/benchmark_results.csv), [JSON](results/benchmark_results.json). Один повтор не измеряет устойчивость. Сводка не объединяет разные бюджеты, подразделения или версии квалификаций.")
    d.heading("Контроль T01–T23")
    by={(r["solver"],r["test"]):r for r in tests}
    codes={"PASS":"PASS","FAIL":"FAIL","NOT_IMPLEMENTED":"N/I","FAIL_INVALID_SOLUTION":"INVALID"}
    d.table(["Тест"]+list(LABELS.values()),[[f"T{i:02d}"]+[codes.get(by.get((sid,f"T{i:02d}"),{}).get("status"),"—") for sid in LABELS] for i in range(1,24)])
    d.p("N/I = сценарий не реализован этим адаптером; это не UNSUPPORTED библиотеки. T01, T11, T12, T20, T21, T23 проверяют общий расчёт ожидания, валидатор, историю и атомарную публикацию в исследовательской SQLite :memory:. Они не считаются native возможностями каждого решателя. В T12 проверяется контракт представления ручной ошибки, а не UI MVP. T04 включает одновременно два HD внутри ВК, T03 — и поздний старт, и выход за смену. [Все доказательства и причины](results/test_matrix.json).")
    failures=[r for r in tests if r["status"] in {"FAIL","FAIL_INVALID_SOLUTION"}]
    if failures:d.table(["Метод","Тест","Бюджет, с","Причина"],[[LABELS[r["solver"]],r["test"],read(r["evidenceFile"],{}).get("budget"),r.get("reason")] for r in failures])
    d.p("Основная контрольная матрица выполнена с бюджетом 2 с; T07/T08 для CBC, SCIP и Choco дополнительно повторены при 15 с. Таблица показывает последнюю проверку, все предыдущие попытки сохранены. CBC и SCIP проходят эти проверки при увеличенном бюджете; у Choco T08 сохраняется разрыв по числу бригад.")
    d.p("FAIL по качеству малого примера в данном бюджете и нарушение жёсткого ограничения различаются. INVALID означает отказ независимой проверки; такие планы не участвуют в сравнении качества.")
    d.heading("Capability matrix и стоимость интеграции")
    mapping={(r["solver"],r["feature"]):r["support"] for r in caps};short={"DIRECT":"D","ADAPTER":"A","NOT_CHECKED":"?","UNSUPPORTED":"U"}
    features=list(dict.fromkeys(r["feature"] for r in caps))
    d.table(["Возможность"]+list(LABELS.values()),[[f]+[short.get(mapping.get((s,f)),"?") for s in LABELS] for f in features])
    d.p("D — механизм библиотеки используется напрямую; A — реализовано собственным моделированием/кодом; ? — не проверено в адаптере; U — доказанно неподдерживаемо в указанной границе API. Ноль U не означает полноту: непроверенные функции сохранены отдельно. Одновременные транспортные профили не тестировались, поскольку владелец задал автомобиль для всех. [Матрица с источниками и пояснениями](results/capability_matrix.json).")
    d.table(["Метод","LOC адаптера со shared","Групп ограничений","Свои операторы","Workarounds","Native функций","Не проверено"],[[LABELS[r["solver"]],r["adapterLOC"],r["customConstraintCount"],r["customOperatorsCount"],r["workaroundCount"],r["nativeFeatureCount"],r["notCheckedFeatureCount"]] for r in complexity])
    d.p("LOC — непустые физические строки, кроме строк только с #/ //; shared-код включён для каждого использующего его метода. Поэтому складывать LOC между методами нельзя. Количество ограничений — число именованных групп бизнес-проверок, не число ограничений сгенерированной модели. Формулы подсчёта, перечни обходных решений, зависимости и ограничения поддержки: [integration_complexity.json](results/integration_complexity.json). Fork решателей для выполненных экспериментов не потребовался.")
    for r in complexity:d.p("**"+LABELS[r["solver"]]+".** "+r["implementationNotes"])
    d.heading("Аварии и динамическое перепланирование")
    manifest=read("datasets/dynamic-hd-v2/manifest.json",{})
    committed=manifest.get("scenarios",[{}])[0].get("committedActivities")
    d.p(f"Все методы получают один зафиксированный ранее план OR-Tools 5 с / seed 1 и одинаковое событие в 11:00. Сохранены {committed} начатых/завершённых действий и три будущих подтверждённых визита. Уже выехавшая бригада освобождается после защищённой работы на её адресе. Новая авария, отмена, недоступность бригады, ручное переназначение и изменение времени — явно синтетические сценарии.")
    d.p("При событии покрытие относится к оставшимся заявкам, штат — ко всему дню, расстояние — только к оставшемуся маршруту. Средняя реакция учитывает исходное время появления каждой оставшейся аварии; реакция на единственную новую аварию выделена отдельно. Начатые работы не записываются в отменённые назначения.")
    d.p("В сценарии недоступности бригады заявка `beeline-v1-southcentral-job-26845` имеет ровно одного исполнителя с нужной ВК/HD; именно он становится недоступным. Даже при нулевой дороге её обслуживание не поместится после следующей доступности. Поэтому верхняя граница покрытия оставшейся очереди здесь — 173 из 174; эту конкретную потерю нельзя приписывать качеству поиска.")
    d.p("Доля полного покрытия буквально требует назначения всей очереди. Для недоступности бригады она неизбежно равна нулю из-за указанной невозможной заявки; здесь качество сравнивается относительно верхней границы 173, а не по достижению 174.")
    policy_groups=defaultdict(list)
    for r in policies:policy_groups[r["solver"],r["scope"],r["policy"],r["timeLimitSec"]].append(r)
    pr=[]
    for (sid,scope,policy,budget),group in sorted(policy_groups.items()):
        valid=[r for r in group if r["eligibleForComparison"]]
        med=lambda k:statistics.median([r[k] for r in valid if r.get(k) is not None]) if any(r.get(k) is not None for r in valid) else None
        pr.append([LABELS[sid],CASES[scope],NAMES[policy],budget,f"{len(valid)}/{len(group)}",med("served"),med("workersUsed"),med("meanResponseDelay"),med("injectedEmergencyResponseMinutes"),med("workerChanges"),med("scheduleChanges")])
    d.table(["Метод","Событие","Политика","с","Допустимо/всего","Заявки, med","Бригады, med","Реакция, med мин","Новая авария, med мин","Смена бригады","Изменение времени"],pr)
    for metric,label in DYNAMIC_METRICS.items():d.image(f"policy-{metric}.png",label)
    d.p("[Все динамические строки](results/policy_results.csv), [среднее, медиана, min/max и std каждой метрики](results/policy_aggregate_metrics.json), [лучшие/медианные/худшие планы по цели политики](results/policy_plan_summary.json), [подробный разбор](reports/POLICIES_AND_REPLANNING.md), [манифест событий](datasets/dynamic-hd-v2/manifest.json). Каждая медиана в таблице относится к отдельной метрике, а не к одному плану. Адаптеры без проверенной аварийной цели не подменяются обычной оптимизацией расстояния.")
    d.heading("Малые точные экземпляры")
    lower=read("results/structural_lower_bounds.json",{})
    if lower.get("datasetVersion")==p["datasetVersion"]:
        d.p(f"Для полного покрытия исходных 203 заявок также получена необходимая нижняя граница: **не менее {lower['staffLowerBoundForFullCoverage']} бригад**. В каждом подразделении перебраны все подмножества его бригад; отсекаются наборы без исполнителя хотя бы для одной заявки или без суммарного времени на обслуживание. Дорога, ожидания и совместное расписание при этом не учитываются. Поэтому граница может быть слабее действительного минимума и не доказывает оптимальность лучшего найденного маршрута.")
        d.table(["Подразделение","Заявки","Часы обслуживания","Минимум по квалификациям","Граница с объёмом работ"],[[r["divisionId"],r["jobs"],r["serviceHours"],r["qualificationCoverageLowerBound"],r["qualificationAndServiceLowerBound"]] for r in lower["divisions"]])
        full=[r for r in main_rows if r["eligibleForComparison"] and r["served"]==r["jobsTotal"]]
        if full:d.p(f"Вместе с реально найденным полным планом это ограничивает неизвестный оптимальный штат интервалом **{lower['staffLowerBoundForFullCoverage']}–{min(r['workersUsed'] for r in full)} бригад**. Верхняя граница — достигнутый результат, нижняя — доказанное необходимое условие; разрыв не выдаётся за доказанный процент неоптимальности.")
        d.p("[Доказательство, исходный отпечаток и границы по подразделениям](results/structural_lower_bounds.json). Далее приведены отдельные малые экземпляры, где оптимальность маршрутов доказана точными методами.")
    exact=[r for r in rows if r["scope"].startswith("exact-")]
    proofs,comparison=exact_comparison(rows)
    d.table(["Заявок","Оптимальное покрытие","Минимальный штат","Оптимальный пробег, км","Доказавшие методы"],[[int(scope.split("-")[1]),info["plan"]["served"],info["plan"]["workersUsed"],info["plan"]["distanceKm"],", ".join(LABELS[s] for s in info["solvers"])] for scope,info in sorted(proofs.items(),key=lambda item:int(item[0].split("-")[1]))])
    d.p("Совпадение с эталоном проверяется по всем трём уровням PRIMARY. Разницу километров имеет смысл показывать только при равных покрытии и штате; меньшее расстояние при лишней бригаде не является улучшением. [Отклонения каждого метода от доказанного оптимума](results/exact_reference_comparison.csv). Противоречащие друг другу сертификаты оптимальности останавливают сборку отчёта.")
    d.table(["Метод","Заявок","с","Статус","Назначено","Бригад","км","Native gap"],[[LABELS[r["solver"]],int(r["scope"].split("-")[1]),r["timeLimitSec"],r["status"],r.get("served"),r.get("workersUsed"),r.get("distanceKm"),r.get("optimalityGap")] for r in sorted(exact,key=lambda r:(int(r["scope"].split("-")[1]),r["solver"],r["timeLimitSec"]))])
    d.p("Подмножества 5/10/15/20 вложены, seed отбора 20260917; остаются те же бригады, точные HD и дорожные пары. OPTIMAL относится только к данному малому экземпляру. FEASIBLE с теми же метриками может совпадать с доказанным оптимумом другого решателя, но собственного доказательства не получает. Native bound/gap сохраняются для диагностики модели, а не как сравнимая между библиотеками стоимость. Gap может превышать 1 при слабой отрицательной границе и не является процентом лишнего пробега. Choco сохраняет доказанность отдельных лексикографических этапов в rawDiagnostics; единой сопоставимой числовой границы его адаптер не возвращает.")
    d.heading("Масштабирование 203 → 500 → 1000")
    d.p("Масштабные наборы с seed 20261418/20261918 содержат 500/1000 отдельных визитов и 88/175 бригад. Спрос выборочно размножен внутри подразделений на существующих адресах; профили бригад размножены пропорционально нагрузке. Окна, длительности и HD унаследованы от выбранных заявок. География и дорожные пары не расширяются. Совпадающие адреса создают нулевой переезд между отдельными визитами: это объявленное свойство генератора, а не слияние заявок.")
    scale_summary=[]
    for group in plan_summaries(scale,["solver","scope","timeLimitSec"]):
        r=group["medianPlan"]
        samples=[v for v in scale if all(v[k]==group[k] for k in ["solver","scope","timeLimitSec"])]
        med=lambda k:statistics.median([v[k] for v in samples if v.get(k) is not None]) if any(v.get(k) is not None for v in samples) else None
        scale_summary.append([LABELS[group["solver"]],group["scope"],group["timeLimitSec"],f"{group['validPlans']}/{group['attempts']}",r.get("seed") if r else None,r.get("served") if r else None,r.get("workersUsed") if r else None,r.get("distanceKm") if r else None,(med("processWallTimeMs")/1000 if med("processWallTimeMs") is not None else None),med("peakMemoryMb"),", ".join(f"{k}: {v}" for k,v in group["statuses"].items())])
    d.table(["Метод","Заявок","с","Допустимо/всего","Seed плана","Назначено","Бригад","км","Wall med, с","RSS med, МиБ","Статусы"],scale_summary)
    scale_errors={}
    for r in scale:
        reason=r.get("errorMessage") or r.get("terminationReason")
        if r.get("errorType")=="TimeoutExpired":
            timeout=re.search(r"timed out after ([0-9.]+) seconds",reason or "")
            reason="Превышен предел ожидания Java-процесса"+(": "+timeout.group(1)+" с" if timeout else "")+". Полная команда сохранена в raw."
        elif reason and len(reason)>450:reason=reason[:450]+"… Подробности в raw."
        if reason:scale_errors[r["solver"],r["scope"],r["status"],reason]=None
    if scale_errors:d.table(["Метод","Размер","Статус","Причина остановки"],[[LABELS[s],scope,status,reason] for s,scope,status,reason in scale_errors])
    if any(r["solver"]=="vroom" and "overflow" in (r.get("errorMessage") or "") for r in scale):
        d.p("У VROOM срабатывает защитная проверка числового диапазона текущего адаптера до поиска. При кодировании строгого приоритета штата фиксированная стоимость каждой бригады равна 1 + N × максимальная дуга; консервативная граница общей стоимости превышает uint32. Данные присутствуют, но эта версия кодирования не передаёт масштабный экземпляр библиотеке. Это ограничение адаптера и выбранных границ, а не доказательство неспособности VROOM решать 500/1000 заявок. Точность расстояний и порядок приоритетов для обхода ошибки не менялись. [Типы стоимости VROOM](https://github.com/VROOM-Project/vroom/blob/v1.15.0/src/structures/typedefs.h).")
    d.p("Показатели качества относятся к одному медианному по PRIMARY допустимому плану; время и память — отдельные медианы всех попыток. При отсутствии плана качество оставлено пустым.")
    d.image("scaling-fullCoverageWorkersUsed.png","Штат при полном покрытии 203/500/1000")
    d.image("scaling-fullCoverageDistanceKm.png","Пробег при полном покрытии 203/500/1000")
    d.p("На двух графиках выше участвуют только планы полного покрытия; отсутствие точки означает, что такой план не получен. Следующие графики включают частичные планы, а графики времени и ресурсов — все попытки. Полосы обозначают min–max имеющихся повторов.")
    for key,label in METRICS.items():d.image(f"scaling-{key}.png",label)
    d.p("[Плотность окон, состав компетенций, матрицы и seed](datasets/scaling-hd-v2/manifest.json), [масштабные результаты CSV](results/scaling_results.csv), [статистика всех метрик](results/scaling_aggregate_metrics.json), [лучшие/медианные/худшие планы](results/scaling_plan_summary.json). Число повторов указано в таблице; один seed не доказывает стабильность на размере 1000.")
    d.heading("Выводы и выбор для проекта" if freeze else "Вывод по выполненной части")
    for budget in [5,15,60,300]:
        medians=[]
        for (sid,b),group in groups.items():
            if b!=budget:continue
            valid=sorted([r for r in group if r["eligibleForComparison"]],key=order)
            if valid:medians.append(valid[len(valid)//2])
        if medians:
            winner=min(medians,key=order)
            d.p(f"На бюджете **{budget} с** лучший из медианных допустимых планов текущих адаптеров дал **{LABELS[winner['solver']]}**: {winner['served']} заявок, {winner['workersUsed']} бригад, {winner['distanceKm']:.3f} км. Это сравнение выполнявшихся конфигураций, с количеством повторов из таблицы; показатель не объявляет библиотеку лучшей для всех постановок.")
    d.p("Статическое качество и продуктовая пригодность оцениваются отдельно. Проверенная динамика с тремя политиками реализована у OR-Tools Routing, ALNS и Timefold. Для VROOM/PyVRP сильный статический результат сам по себе не подтверждает эквивалентность аварийной цели: её нельзя заменить приоритетом заявки или общим временем маршрута. Для jsprit нужна отдельная реализация защиты и зависимой от времени стоимости. Универсальные CP/MIP методы дополнительно оцениваются по доказательствам на малых задачах, а не только по скорости полного плана.")
    d.p("**Цена адаптации влияет на результат.** ALNS содержит собственный планировщик и операторы; Timefold использует начальный EasyScoreCalculator без инкрементального ускорения; CP/MIP используют одну общую потоковую формулировку. Измерение относится к этим реализациям и параметрам, а не доказывает теоретическое превосходство семейства алгоритмов.")
    if freeze:
        for paragraph in decision.get("conclusions",[]):d.p(paragraph)
        if decision.get("shortlist"):d.table(["Кандидат","Роль в проекте","Основание","Ограничение"],[[r["solver"],r["role"],r["evidence"],r["limitation"]] for r in decision["shortlist"]])
        for paragraph in decision.get("limits",[]):d.p(paragraph)
        d.p("Новые расчёты для этого отчёта не требуются. Сохранённые числа дают основание для выбора в данном тестовом сценарии, но не означают доказанное превосходство на любых данных. Для реального внедрения необходимо заменить объявленные модельные адреса и смены фактическими данными.")
    else:
        d.p("Пока отсутствующие повторы, бюджеты или масштабные строки видны в таблицах, окончательный shortlist не зафиксирован. [Список недостающих основных запусков](results/missing_main_runs.json). Для внедрения также потребуется подтвердить спорные офисные адреса и фактические смены; текущие выводы относятся к согласованному эксперименту на автомобилях без перерывов.")
    d.p("Воспроизведение: [README](README.md), [окружение](registry/environment.json), [точка продолжения](../CONTINUE_HERE.md). Dataset SHA: `"+p["datasetVersion"]+"`. Matrix SHA: `"+p["matrixVersion"]+"`.")
    d.p("[Единая выгрузка всех статических, динамических и масштабных измерений](results/all_benchmark_results.csv) сохраняет тип эксперимента, scope, политику, бюджет, seed и версии данных. Это совместное хранение строк, а не усреднение разных задач.")
    d.p("После сборки выполняется [повторный аудит опубликованных планов и метрик](results/report_evidence_audit.json): сверяются отпечатки входов, заново запускается независимый валидатор, пересчитываются метрики и проверяются границы CP-SAT/SCIP/CBC. Самих оптимизаторов эта проверка не запускает.")
    d.write();print(json.dumps({"static":len(rows),"policies":len(policies),"scale":len(scale),"mainCompleted":len(planned&actual),"mainPlanned":len(planned),"report":"REPORT.html"}))


if __name__=="__main__":main()
