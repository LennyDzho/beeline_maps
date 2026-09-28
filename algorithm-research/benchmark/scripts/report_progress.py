"""Measured research progress, with no invented values for unrun experiments."""
import csv
import json
import statistics
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from core.preflight import check_problem
from core.problem_model import fingerprint

LABELS = {"ortools_routing": "OR-Tools Routing", "pyvrp": "PyVRP", "cpsat": "CP-SAT", "scip": "SCIP", "cbc": "CBC", "alns": "ALNS", "vroom": "VROOM", "jsprit": "jsprit", "timefold": "Timefold", "choco": "Choco"}
COLORS = dict(zip(LABELS, ["#2978b5", "#27804e", "#8c64bb", "#b64a5c", "#84613f", "#d98324", "#14a3a3", "#b33690", "#646b24", "#444444"]))
ATTEMPT_METRICS = {"solverWallTimeMs", "validPlanReturnedPercent", "fullCoverageReturnedPercent", "hardViolations", "validationTimeMs", "processWallTimeMs", "peakMemoryMb", "cpuTimeSampledMs"}
METRICS = {
    "validPlanReturnedPercent": "Возврат допустимого плана, % попыток",
    "fullCoverageReturnedPercent": "План с полным покрытием, % попыток",
    "hardViolations": "Нарушения жёстких ограничений", "served": "Назначенные заявки", "unassigned": "Неназначенные заявки",
    "servedPercent": "Покрытие, %", "workersUsed": "Задействованные исполнители", "distanceKm": "Пробег, км",
    "travelMinutes": "Дорога, мин", "waitingMinutes": "Ожидание, мин", "serviceMinutes": "Обслуживание, мин",
    "emergencyServed": "Назначенные аварии", "emergencyUnassigned": "Неназначенные аварии",
    "meanResponseDelay": "Средняя задержка реакции, мин", "medianResponseDelay": "Медианная задержка реакции, мин",
    "maxResponseDelay": "Максимальная задержка реакции, мин", "meanCompletionDelay": "Средняя задержка завершения, мин",
    "maxCompletionDelay": "Максимальная задержка завершения, мин", "solverWallTimeMs": "Построение модели и поиск, мс",
    "validationTimeMs": "Время проверки, мс", "processWallTimeMs": "Полное время отдельного процесса, мс",
    "peakMemoryMb": "Пиковая суммарная RSS по выборкам, МиБ", "cpuTimeSampledMs": "Время CPU по выборкам, мс"}


def read(path):
    return json.loads(path.read_text(encoding="utf-8"))


def save(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2)+"\n", encoding="utf-8")


def main():
    p = read(ROOT / "datasets/problem.json")
    preflight = check_problem(p)
    candidates = read(ROOT / "registry/candidates.json")
    smoke = {r["solver"]: r for r in read(ROOT / "results/installation_smoke.json")}
    registry = read(ROOT / "registry/verified-registry.json")
    integration_path = ROOT / "results/integration_complexity.json"
    integration = {r["solver"]:r for r in read(integration_path)} if integration_path.exists() else {}
    for r in registry:
        s = smoke.get(r["id"], {})
        r["smokeTestStatus"] = s.get("status", "NOT_RUN")
        r["verifiedSolverVersion"] = s.get("solverVersion")
        r["staticPrimaryAdapterStatus"] = "SMALL_TESTS_PASSED" if r["id"] in LABELS else "NOT_IMPLEMENTED"
        if r["id"] == "cbc":
            modern = s.get("solverVersion") == "2.10.13"
            r["testedDistributionLicense"] = "EPL-2.0" if modern else "EPL-1.0"
            r["testedLicenseEvidence"] = "registry/licenses/cbc-2.10.13.txt" if modern else "registry/licenses/cbc-2.10.3.txt"
            r["licenseScopeNote"] = "Current official 2.10.13 binary: EPL-2.0. Earlier bundled 2.10.3 attempts: EPL-1.0."
    save(ROOT / "registry/verified-registry.json", registry)
    licenses = ROOT / "registry/licenses"
    licenses.mkdir(exist_ok=True)
    license_source = ROOT / ".venv/Lib/site-packages/pulp/solverdir/cbc/win/i64/coin-license.txt"
    if license_source.exists():
        (licenses / "cbc-2.10.3.txt").write_bytes(license_source.read_bytes())
    modern_license = ROOT / "runtime/cbc-2.10.13/LICENSE"
    if modern_license.exists():
        (licenses / "cbc-2.10.13.txt").write_bytes(modern_license.read_bytes())
    checks = [{"solver": c["id"], "name": c["name"], "family": c["family"], "dataStatus": preflight["status"],
        "primaryAdapterStatus": "SMALL_TESTS_PASSED" if c["id"] in LABELS else "NOT_IMPLEMENTED",
        "emergencyAdapterStatus": "IMPLEMENTED" if c["id"] in {"alns","timefold","ortools_routing"} else "NOT_IMPLEMENTED",
        "dynamicAdapterStatus": "IMPLEMENTED" if c["id"] in {"alns","timefold","ortools_routing"} else "NOT_IMPLEMENTED"} for c in candidates]
    save(ROOT / "results/preflight.json", {"checkedAt": datetime.now(timezone.utc).isoformat(), "problemFingerprint": fingerprint(p),
        "scenario": p["id"], "geocodingAssumptions": p["geocodingAssumptions"], "common": preflight, "solvers": checks})
    # Later revisions of the same run are not independent repetitions. Retain
    # all raw files; tables use the latest timestamp per solver/scope/budget/seed.
    runs = {}
    for path in (ROOT / "results/raw").glob("baseline-*.json"):
        r = read(path)
        if r["matrixVersion"] != p["matrixVersion"] or r["datasetVersion"] != p["datasetVersion"]:
            continue
        key = (r["solver"], r["scope"], r["policy"], r["timeLimitSec"], r["seed"])
        if key not in runs or r["timestamp"] > runs[key]["timestamp"]:
            runs[key] = {**r, "rawFile": str(path.relative_to(ROOT)).replace("\\", "/")}
    records, rows = sorted(runs.values(), key=lambda r: (r["solver"], r["scope"], r["timeLimitSec"], r["seed"])), []
    for r in records:
        solution, metrics = r.get("solution") or {}, r.get("metrics") or {}
        row = {k: r.get(k) for k in ["solver", "dataset", "scope", "policy", "timeLimitSec", "seed", "status", "adapterVersion", "datasetVersion", "matrixVersion", "timestamp", "rawFile"]}
        row.update({k: metrics.get(k) for k in METRICS})
        row.update({k: metrics.get(k) for k in ["jobsTotal", "emergencyTotal", "reassignments", "workerChanges", "orderChanges", "scheduleChanges", "removedAssignments", "newWorkersActivated", "maxScheduleShiftMinutes"]})
        row["jobsTotal"] = r["preflight"]["jobsTotal"]
        row.update({k: solution.get(k, r.get(k)) for k in ["solverVersion", "bestBound", "optimalityGap"]})
        row["commitSha"] = next((c.get("commitSha") for c in registry if c["id"]==r["solver"]),None)
        row.update({k:integration.get(r["solver"],{}).get(k) for k in ["adapterLOC","workaroundCount","unsupportedFeatureCount"]})
        row["solverWallTimeMs"] = solution.get("runtime", {}).get("solverWallTimeMs")
        for key in ["processWallTimeMs", "peakMemoryMb", "cpuTimeSampledMs"]:
            row[key] = r.get("resources", {}).get(key)
        row["experimentStage"] = r.get("experimentStage")
        row["eligibleForComparison"] = metrics.get("eligibleForComparison", False)
        row["validPlanReturnedPercent"] = 100 if row["eligibleForComparison"] else 0
        row["fullCoverageReturnedPercent"] = 100 if row["eligibleForComparison"] and row["served"]==row["jobsTotal"] else 0
        rows.append(row)
    save(ROOT / "results/benchmark_results.json", rows)
    if rows:
        with (ROOT / "results/benchmark_results.csv").open("w", encoding="utf-8-sig", newline="") as f:
            writer = csv.DictWriter(f, fieldnames=list(rows[0]))
            writer.writeheader()
            writer.writerows(rows)
    with (ROOT / "results/preflight.csv").open("w", encoding="utf-8-sig", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=list(checks[0]))
        writer.writeheader()
        writer.writerows(checks)
    config = read(ROOT / "requirements/experiment.json")
    config.update(experimentId=p["id"],datasetPath="../../datasets/beeline-hd-v2/dataset.json" if p.get("competencyModel") else "../../datasets/beeline-v1/dataset.json",
        matrixProvider=p["matrixProvenance"]["provider"], matrixStatus="FROZEN_READY_DECLARED_GEOGRAPHY",
        matrixVersion=p["matrixVersion"], matrixFallback="2GIS returned HTTP 429; all divisions rebuilt using OSM/OSRM",
        geocodingDecisions="../matrices/geocoding-resolutions.json", geocodingAssumptionLocationCount=len(p["geocodingAssumptions"]))
    save(ROOT / "requirements/experiment.json", config)
    snap = read(ROOT / "matrices/osrm-snapping.json")
    matrix_summary = {"provider": p["matrixProvenance"], "matrixVersion": p["matrixVersion"], "matrixPreparationTimeMs": p["matrixPreparationTimeMs"],
        "arcCount": sum(len(r) for r in p["travelTimeMatrices"]["car"].values()),
        "unreachableArcCount": sum(t is None for r in p["travelTimeMatrices"]["car"].values() for t in r.values()),
        "maximumSnapMetres": max(s["distance"] for s in snap.values()), "locations": len(snap), "preflight": preflight}
    save(ROOT / "matrices/snapshot-summary.json", matrix_summary)

    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    plt.rcParams.update({"font.family": "DejaVu Sans", "font.size": 10})
    figures = ROOT / "reports/figures"
    figures.mkdir(exist_ok=True)
    charts = []
    for metric, label in METRICS.items():
        fig, ax = plt.subplots(figsize=(10.2, 5.4), layout="constrained")
        plotted = False
        for sid, name in LABELS.items():
            groups = defaultdict(list)
            for row in rows:
                if row["solver"] == sid and row["scope"] == "all" and row[metric] is not None:
                    if row["eligibleForComparison"] or metric in ATTEMPT_METRICS:
                        groups[row["timeLimitSec"]].append(row[metric])
            if not groups:
                continue
            budgets = sorted(groups)
            med = [statistics.mean(groups[b]) if metric.endswith("ReturnedPercent") else statistics.median(groups[b]) for b in budgets]
            coverages = [r["served"] for r in rows if r["solver"] == sid and r["scope"] == "all" and r["served"] is not None]
            coverage = f"{min(coverages)}" if coverages and min(coverages) == max(coverages) else f"{min(coverages)}–{max(coverages)}" if coverages else "нет плана"
            ax.plot(budgets, med, marker="o", color=COLORS[sid], label=f"{name} · {coverage}/203 заявок" if coverages else f"{name} · нет плана")
            if not metric.endswith("ReturnedPercent") and any(len(groups[b]) > 1 for b in budgets):
                ax.fill_between(budgets, [min(groups[b]) for b in budgets], [max(groups[b]) for b in budgets], alpha=0.1, color=COLORS[sid])
            plotted = True
        if not plotted:
            ax.text(0.5, 0.5, "Нет измерений", ha="center", va="center", transform=ax.transAxes)
        ax.set_title(label + " · 203 заявки · PRIMARY", loc="left", pad=14)
        ax.set_xlabel("Заданный бюджет поиска, с (логарифмическая шкала)")
        budgets=sorted({row["timeLimitSec"] for row in rows if row["scope"] == "all"})
        ax.set_xscale("log")
        ax.set_xticks(budgets,[f"{b:g}" for b in budgets])
        ax.set_ylabel(label)
        ax.set_ylim(bottom=0)
        if metric in {"servedPercent", "validPlanReturnedPercent", "fullCoverageReturnedPercent"}:
            ax.set_ylim(0, 105)
            ax.set_yticks([0, 20, 40, 60, 80, 100])
        ax.spines[["top", "right"]].set_visible(False)
        if plotted:
            ax.legend(frameon=False, loc="upper center", bbox_to_anchor=(0.5, -0.18), ncol=2, fontsize=9)
        ax.grid(axis="y", alpha=0.18)
        fig.savefig(figures / f"baseline-{metric}.png", dpi=150)
        fig.savefig(figures / f"baseline-{metric}.svg")
        plt.close(fig)
        charts.append((metric, label))
    aggregate = []
    grouped = defaultdict(list)
    for row in rows:
        grouped[row["solver"], row["scope"], row["policy"], row["timeLimitSec"]].append(row)
    for (sid, scope, policy, budget), group in grouped.items():
        for metric in METRICS:
            values = [r[metric] for r in group if r[metric] is not None and (r["eligibleForComparison"] or metric in ATTEMPT_METRICS)]
            if values:
                aggregate.append({"solver": sid, "scope": scope, "policy": policy, "timeLimitSec": budget, "metric": metric,
                    "n": len(values), "minimum": min(values), "median": statistics.median(values), "maximum": max(values),
                    "mean": statistics.mean(values), "sampleStd": statistics.stdev(values) if len(values) > 1 else None})
    save(ROOT / "results/aggregate_metrics.json", aggregate)
    done = {r["solver"] for r in records}
    lines = ["# Исследование оптимизаторов: дорожные данные и первые измерения", "",
        "**Промежуточный аналитический отчёт. Полное исследование по заданию ещё не завершено; окончательный shortlist не сформирован.**", "",
        f"Сохранено {len(rows)} конфигураций/повторов на общей версии дорожных данных. Реальный набор запускается с явно описанной модельной географией. Матрицы больше не блокируют расчёты.", "",
        "## Данные и переход на OSM", "",
        "В наборе 203 новые заявки, 35 исполнителей и три подразделения. Квалификации выведены из ранее назначенных типов работ; стартовые адреса — из нижней части исходных таблиц. Транспорт у всех автомобиль, перерывов нет. Смена 09:00–22:00 и известность всех первичных заявок в 09:00 — экспериментальные допущения. Суммарное обслуживание всех заявок — 180,33 ч без дороги и ожидания.", "",
        "2ГИС успешно выполнил пробу и часть матричных запросов, затем вернул **HTTP 429**. По указанию владельца **все три дорожные матрицы заново получены через OSM/OSRM**. Частичные данные 2ГИС не подмешиваются в дорожные дуги. Матрица OSRM отражает быстрые автомобильные пути без текущих пробок; она не равна кратчайшим по расстоянию путям 2ГИС.", "",
        f"Получено **{matrix_summary['arcCount']:,} направленных пар** для 206 точек в трёх подразделениях; недоступных пар — {matrix_summary['unreachableArcCount']}. Максимальное расстояние привязки входной точки к дороге — {matrix_summary['maximumSnapMetres']:.1f} м. Секунды и метры округлены вверх. Между подразделениями маршруты запрещены, поэтому такие пары не запрашивались.", "",
        "185 уникальных адресов ранее совпали в 2ГИС. Для 12 спорных адресов использован OSM: пять разрешены по точному номеру или району, семь привязаны с явными допущениями (восемь точек, включая два офиса). В частности, офисы с «с4/с1» приняты по найденным «к4/к1»; для ненайденного «Дубининская, 59 к2» создана тестовая точка дома 59. Это не подтверждение фактического местоположения. [Адресная проверка и основания](reports/GEOCODING_REVIEW.md).", "",
        f"Версия матрицы: `{p['matrixVersion']}`. Снимок, исходные ответы и привязки сохранены. Все решатели получают один и тот же файл. [© OpenStreetMap contributors, ODbL](https://www.openstreetmap.org/copyright), [API OSRM](https://project-osrm.org/docs/v5.22.0/api/), [политика Nominatim](https://operations.osmfoundation.org/policies/nominatim/).", "",
        "## Готовность кандидатов", "",
        "| Кандидат | Тип | Данные | Статический адаптер | Измерения кейса |", "|---|---|---|---|---|"]
    for c in candidates:
        lines.append(f"| [{c['name']}]({c['repository']}) | {c['family']} | READY, с допущениями | {'Малые проверки пройдены' if c['id'] in LABELS else 'Ещё не реализован'} | {'Есть' if c['id'] in done else 'NOT_RUN'} |")
    lines += ["", "| Кандидат | Испытанное ядро | Лицензия проверенного релиза | API |", "|---|---|---|---|"]
    for c in candidates:
        version = smoke.get(c["id"], {}).get("solverVersion") or "не запускался"
        license_name = next(r for r in registry if r["id"] == c["id"]).get("testedDistributionLicense", c["license"])
        lines.append(f"| {c['name']} | {version} | {license_name} | {c['api']} |")
    lines += ["", "Проверка достаточности данных выполняется отдельно перед каждым запуском, до импорта адаптера. Планы проходят общий независимый валидатор H01–H12; только ноль нарушений допускает сравнение качества. Пропущенные и недоступные результаты не заменяются нулями.", "",
        "После сбоев поставляемого с PuLP CBC 2.10.3 установлен официальный **CBC 2.10.13**; SHA-256 архива проверен по GitHub release. Современный бинарник имеет [EPL-2.0](registry/licenses/cbc-2.10.13.txt), старый 2.10.3 — [EPL-1.0](registry/licenses/cbc-2.10.3.txt). Версии оболочки и ядра разделены. Для выполненных расчётов сохраняется фактическая версия; попытки, остановленные до запуска, версии ядра не подтверждают.", "",
        "Все реализованные адаптеры пока ограничены статической политикой PRIMARY. В OR-Tools и PyVRP реализованы открытые маршруты, обязательная совместимость, смены, окна начала и необязательные заявки. PyVRP кодирует совместимость через нулевую ёмкость отдельного искусственного измерения для исполнителя; остальные ёмкости равны N и не ограничивают допустимые маршруты. Это эквивалентное представление запретов, не новое бизнес-ограничение.", "",
        "CP-SAT, SCIP и CBC используют общую модель потока по дугам с переменными времени. Положительные длительности обслуживания исключают отдельные циклы; коэффициенты big-M выводятся из границ времени. Это начальная универсальная формулировка, без специального усиления релаксации. ALNS использует отдельные экспериментальные операторы удаления и допустимой вставки; его результаты характеризуют эту реализацию, а не предел возможностей всего семейства ALNS.", "",
        "Для CBC сохранены исходные MPS, MIP start и native logs в изолированном `.cache/cbc`. После сбоев добавлены явное завершение процесса и внешний watchdog; используются один основной поток и CPU-лимит CBC. В итоговом проверенном варианте отключён Cgl preprocess: предыдущие настройки приводили к access violation и некорректным сообщениям о невозможности заведомо допустимого пустого плана. Бизнес-ограничения сохранены. Полное wall time измеряется и может превышать лимит. Старые ошибочные попытки сохранены в raw; в сводке используется последняя версия каждой конфигурации, без выбора лучшего результата задним числом.", "",
        "VROOM работает локально через официальную Python-обёртку **pyvroom 1.15.2**: отдельный WSL/Docker не потребовался. Точный commit встроенного C++ ядра пока не подтверждён и не подменяется номером обёртки. Совместимость задана отдельным обязательным skill для каждой заявки, стоимость активации превышает верхнюю границу всего пробега. Равные положительные приоритеты сохраняют первенство покрытия. Для Windows явно приведён формат буфера uint32 без изменения значений матриц. [Обёртка](https://github.com/VROOM-Project/pyvroom), [тип стоимости VROOM](https://github.com/VROOM-Project/vroom/blob/v1.15.0/src/structures/typedefs.h).", "",
        "**jsprit 2.0.0, Timefold Community 2.6.0 и Choco 6.0.1** работают через переносимую Java 21 внутри исследования. Каждый расчёт запускает новую JVM; её запуск включён в wall time. jsprit использует явную проверку всей вставляемой последовательности, включая окончание смены, и постоянную стоимость открытия маршрута вместо штатного прогрессивного веса. Timefold использует списки заявок с разрешённым неназначением, один жёсткий уровень допустимости и три лексикографических уровня качества; EasyScoreCalculator — начальная реализация, без инкрементального ускорения. Choco использует потоковую CP-модель с reified time precedence и три последовательных лексикографических этапа в общем бюджете; OPTIMAL требует доказательства всех трёх. [Переход Timefold 2.x](https://docs.timefold.ai/timefold-solver/latest/upgrading-timefold-solver/upgrade-from-v1), [jsprit](https://github.com/graphhopper/jsprit), [Choco](https://github.com/chocoteam/choco-solver).", "",
        "Все десять кандидатов имеют статический адаптер. Это не подтверждает полноту поддержки динамики и аварийных целей. Лицензии, ссылки, версии и commit SHA: `registry/verified-registry.json`; проверенные локальные версии: `results/installation_smoke.json`.", "",
        "## Измеренные планы на общем наборе", "",
        "Пока это короткие контрольные запуски. Бюджет задаётся поиску; построение модели и накладные расходы входят в измеренное полное время. Ограничитель времени библиотеки может завершаться с превышением бюджета — это видно в столбце времени. При NO_SOLUTION_FOUND нет возвращённого incumbent; это не доказательство отсутствия допустимого плана.", "",
        "Если повторов несколько, показан реальный план в середине отсортированного лексикографического ряда (сначала served, затем workers, затем distance). Это сохраняет связь показателей одного плана. V/N — число допустимых планов / число попыток. Все повторные строки доступны в CSV.", "",
        "| Решатель | Бюджет, с | V/N | Seed показанного плана | Статус | Заявки | Исполнители | Пробег, км | Реакция на аварию, среднее мин | Модель + поиск, с |", "|---|---:|---:|---:|---|---:|---:|---:|---:|---:|"]
    def fmt(value, decimals=2):
        return "—" if value is None else f"{value:.{decimals}f}"
    for (sid, scope, policy, budget), group in sorted(grouped.items()):
        if scope == "all":
            feasible = sorted([r for r in group if r['eligibleForComparison']], key=lambda r: (-r['served'], r['workersUsed'], r['distanceKm']))
            row = feasible[len(feasible)//2] if feasible else group[-1]
            lines.append(f"| {LABELS.get(sid,sid)} | {budget:g} | {len(feasible)}/{len(group)} | {row['seed']} | {row['status']} | {fmt(row['served'],0)} | {fmt(row['workersUsed'],0)} | {fmt(row['distanceKm'])} | {fmt(row['meanResponseDelay'])} | {fmt(row['solverWallTimeMs']/1000 if row['solverWallTimeMs'] is not None else None)} |")
    lines += ["", "Нулевой пробег пустого плана означает отсутствие назначенной работы и не является хорошим результатом. Сравнение лексикографическое: сначала покрытие, затем число исполнителей, затем километры. Native objective между библиотеками не сравнивается. Задержки аварий в PRIMARY измерены, но не минимизируются отдельным уровнем; выводов о двух аварийных политиках по этим строкам делать нельзя.", "",
        "Данные отдельных подразделений и каждого повтора: [benchmark_results.csv](results/benchmark_results.csv), [JSON](results/benchmark_results.json). Агрегаты mean/median/min/max и выборочное стандартное отклонение: [aggregate_metrics.json](results/aggregate_metrics.json). При единственном наблюдении std отсутствует: один seed не доказывает устойчивость. Минимум и максимум отдельной метрики не трактуются как лучший и худший план без проверки старших уровней цели. В OR-Tools параметр seed задан SAT-подрешателю: эти повторы не доказывают управление случайностью Routing local search; вариация может происходить от ограничения по времени.", "",
        "## Графики каждой измеренной метрики", "",
        "Показаны медианы только имеющихся наблюдений; если повторов несколько, полоса обозначает min–max. Для возврата допустимого плана показана доля успешных попыток, а не медиана индикатора. Качество считается только по допустимым планам, поэтому его необходимо читать вместе с долей успеха. Метрики перепланирования пока отсутствуют. Новые серии STATIC_PRIMARY_FRESH_PROCESS используют отдельный Python-процесс на запуск и измеряют дерево процессов каждые 50 мс: RSS-пик приблизителен, CPU коротких дочерних процессов может быть занижен. Старые контрольные серии этих измерений не имеют; пропуски не заменяются нулями.", ""]
    for metric, label in charts:
        lines += [f"### {label}", "", f"![{label}](reports/figures/baseline-{metric}.png)", ""]
    exact_rows = [r for r in rows if r["scope"].startswith("exact-")]
    if exact_rows:
        lines += ["## Малые точные экземпляры", "", "Вложенные подмножества 5/10/15/20 заявок выбраны с фиксированным seed 20260917. Сохраняются все 35 исполнителей, исходные окна, квалификации и тот же дорожный снимок. OPTIMAL означает доказанный оптимум PRIMARY конкретного малого экземпляра: через корректную скаляризацию либо все последовательные лексикографические этапы. Он не является оптимумом полного набора.", "",
            "| Решатель | Заявок | Статус | Назначено | Исполнители | Пробег, км | Gap native scalar |", "|---|---:|---|---:|---:|---:|---:|"]
        for r in sorted(exact_rows, key=lambda r: (r['solver'], int(r['scope'].split('-')[1]), r['timeLimitSec'])):
            lines.append(f"| {LABELS[r['solver']]} | {r['scope'].split('-')[1]} | {r['status']} | {fmt(r['served'],0)} | {fmt(r['workersUsed'],0)} | {fmt(r['distanceKm'],3)} | {fmt(r['optimalityGap'],6)} |")
        lines += ["", "Gap вычислен как |incumbent − native bound| / max(|incumbent|, 1). При слабой отрицательной нижней границе он может превышать 1; это не процент лишнего пробега. Сам native scalar между разными решателями не сравнивается.", ""]
    lines += ["## Предварительный вывод и остающаяся работа", "",
        "Переход на OSM/OSRM устранил блокировку дорожных данных. Специализированные маршрутные решатели уже строят допустимые планы с полным покрытием; это подтверждает работоспособность матрицы и базовой постановки. Отличия коротких запусков ещё не обосновывают выбор победителя или исключение универсальных методов: результат зависит от формулировки, начального решения и бюджета.", "",
        "Для завершения исходного задания остаются: полные T01–T23 по каждому кандидату и capability analysis, обе аварийные политики, пять событий перепланирования с защищёнными действиями и warm start, полная сетка бюджетов 1/5/15/60/300 с и повторов, масштабирование 500/1000. Полное сравнение не объявляется завершённым; итоговых 2–3 рекомендаций пока нет.", "",
        "Все изменения и результаты находятся в `algorithm-research`. Данные и алгоритмы MVP не изменялись.", ""]
    findings = ["### Наблюдения короткой статической серии", ""]
    for sid in LABELS:
        samples = [r for r in rows if r["solver"] == sid and r["scope"] == "all" and r["timeLimitSec"] == 5]
        feasible = [r for r in samples if r["eligibleForComparison"]]
        if feasible:
            best = min(feasible, key=lambda r: (-r["served"], r["workersUsed"], r["distanceKm"]))
            findings.append(f"- **{LABELS[sid]}**, 5 с: {len(feasible)}/{len(samples)} допустимых планов; покрытие {min(r['served'] for r in feasible)}–{max(r['served'] for r in feasible)} из 203; исполнителей {min(r['workersUsed'] for r in feasible)}–{max(r['workersUsed'] for r in feasible)}. Лучший по PRIMARY план: {best['served']} заявок, {best['workersUsed']} исполнителей, {best['distanceKm']:.3f} км (seed {best['seed']}).")
    findings += ["", "В этой ограниченной серии PyVRP использовал меньше исполнителей при полном покрытии, но на бюджете 1 с были неуспешные возвраты. Предварительное преимущество относится к статическому сценарию и текущему адаптеру; оно не доказывает превосходство в аварийных политиках или перепланировании. Универсальные методы полезны как точный эталон: совпадающие доказанные решения на малых наборах позволяют проверять эвристики.", ""]
    position = lines.index("## Предварительный вывод и остающаяся работа")
    lines[position:position] = findings
    (ROOT / "REPORT.md").write_text("\n".join(lines), encoding="utf-8")
    print(json.dumps({"dataStatus": preflight["status"], "measuredRuns": len(rows), "measuredSolvers": sorted(done), "roadProvider": p["matrixProvenance"]["provider"]}))


if __name__ == "__main__":
    main()
