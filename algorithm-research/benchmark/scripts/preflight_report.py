"""Auditable data-readiness report. Never creates fictitious solver metrics."""

import csv
import importlib.metadata
import json
import sys
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from core.preflight import check_problem
from core.problem_model import fingerprint, prepare_problem


def read(path):
    return json.loads(path.read_text(encoding="utf-8"))


def save(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def main():
    if (ROOT / "datasets/problem.json").exists():
        # Preserve actual results and feature test records once runs exist.
        from report_progress import main as current_report
        from record_capabilities import main as capabilities
        from report_policies import main as policies
        from report_research import main as research
        from audit_report_evidence import main as evidence_audit
        from structural_lower_bounds import main as lower_bounds
        lower_bounds(); current_report(); policies(); capabilities(); research(); evidence_audit()
        return
    config = read(ROOT / "requirements/experiment.json")
    dataset = read(ROOT.parent / "datasets/beeline-v1/dataset.json")
    problem = prepare_problem(dataset, config)
    cache = read(ROOT / "matrices/geocoding.json") if (ROOT / "matrices/geocoding.json").exists() else {}
    for worker in problem["workers"]:
        selected = cache.get(worker["startAddress"], {}).get("selected")
        worker["startCoordinates"] = selected["point"] if selected else None
    for job in problem["jobs"]:
        selected = cache.get(job["address"], {}).get("selected")
        job["coordinates"] = selected["point"] if selected else None
    save(ROOT / "datasets/problem.pending.json", problem)
    preflight = check_problem(problem)
    candidates = read(ROOT / "registry/candidates.json")
    registry = {c["id"]: c for c in read(ROOT / "registry/verified-registry.json")}
    smoke = {c["solver"]: c for c in read(ROOT / "results/installation_smoke.json")}
    checks = []
    for candidate in candidates:
        sid = candidate["id"]
        checks.append({"solver": sid, "name": candidate["name"], "family": candidate["family"],
            "dataStatus": preflight["status"], "issueCounts": dict(Counter(x["code"] for x in preflight["issues"])),
            "smokeStatus": smoke.get(sid, {}).get("status", "NOT_RUN"),
            "testedSolverVersion": smoke.get(sid, {}).get("solverVersion"),
            "primaryAdapterStatus": "IMPLEMENTED_TINY_TESTED" if sid == "ortools_routing" else "NOT_IMPLEMENTED",
            "emergencyAdapterStatus": "NOT_IMPLEMENTED", "dynamicAdapterStatus": "NOT_IMPLEMENTED",
            "mainBenchmarkStatus": "NOT_RUN", "eligibleForRanking": False})
    audited = {"checkedAt": datetime.now(timezone.utc).isoformat(), "problemFingerprint": fingerprint(problem),
               "common": preflight, "solvers": checks}
    save(ROOT / "results/preflight.json", audited)
    with (ROOT / "results/preflight.csv").open("w", encoding="utf-8-sig", newline="") as stream:
        writer = csv.DictWriter(stream, fieldnames=[k for k in checks[0] if k != "issueCounts"])
        writer.writeheader()
        writer.writerows({k: v for k, v in row.items() if k != "issueCounts"} for row in checks)

    # Test matrix deliberately records NOT_RUN until each solver is exercised.
    with (ROOT / "results/test_matrix.csv").open("w", encoding="utf-8-sig", newline="") as stream:
        writer = csv.writer(stream)
        writer.writerow(["solver"] + [f"T{i:02d}" for i in range(1, 24)])
        for candidate in candidates:
            writer.writerow([candidate["id"]] + ["NOT_RUN"]*23)
    features = ["time_windows", "optional_jobs", "skills", "transport", "heterogeneous_workers", "shifts", "start_locations", "open_routes", "external_matrices", "matrix_profiles", "worker_activation", "lexicographic_objective", "emergency_response", "warm_start", "fixed_activities", "protected_prefix", "time_limit", "best_feasible", "random_seed", "diagnostics"]
    with (ROOT / "results/capability_matrix.csv").open("w", encoding="utf-8-sig", newline="") as stream:
        writer = csv.writer(stream)
        writer.writerow(["solver", "feature", "status", "evidence"])
        for candidate in candidates:
            for feature in features:
                # Installation and general product descriptions are not feature tests.
                writer.writerow([candidate["id"], feature, "NOT_CHECKED", candidate["documentation"]])

    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    plt.rcParams.update({"font.family": "DejaVu Sans", "font.size": 10})
    figdir = ROOT / "reports/figures"
    fields = [
        ("Навыки исполнителей", sum(bool(w["skills"]) for w in problem["workers"]), 35),
        ("Смены и автомобиль", sum(w["transportMode"] == "car" for w in problem["workers"]), 35),
        ("Адреса старта", sum(bool(w["startAddress"]) for w in problem["workers"]), 35),
        ("Координаты старта", sum(w["startCoordinates"] is not None for w in problem["workers"]), 35),
        ("Координаты заявок", sum(j["coordinates"] is not None for j in problem["jobs"]), 203),
        ("Нормативы обслуживания", sum(j["serviceDuration"] > 0 for j in problem["jobs"]), 203),
        ("Окна и время появления", len(problem["jobs"]), 203),
        ("Общая дорожная матрица", int(problem["matrixVersion"] is not None), 1),
    ]
    fig, ax = plt.subplots(figsize=(10.5, 5.2), layout="constrained")
    ax.barh(range(len(fields)), [100]*len(fields), color="#e6e9ee")
    ax.barh(range(len(fields)), [100*n/d for _, n, d in fields], color="#207c77")
    ax.set_yticks(range(len(fields)), [f"{name}  ({n}/{d})" for name, n, d in fields])
    ax.invert_yaxis()
    ax.set_xlim(0, 105)
    ax.set_xlabel("Заполненные и проверенные записи, %")
    ax.set_title("Готовность входных данных — не рейтинг оптимизаторов", loc="left", pad=14)
    ax.spines[["top", "right"]].set_visible(False)
    fig.savefig(figdir / "data-readiness.png", dpi=160)
    fig.savefig(figdir / "data-readiness.svg")
    plt.close(fig)

    divisions = [("east", "Восток"), ("southeast", "Юго-восток"), ("southcentral", "Югоцентр")]
    categories = [("Подключение", "#246c97"), ("Локальная заявка", "#207c77"), ("Глобальная проблема", "#dc8c42"), ("Дозаказ", "#9b83bd")]
    fig, ax = plt.subplots(figsize=(9, 5), layout="constrained")
    bottom = [0.0]*3
    for category, color in categories:
        values = [sum(j["serviceDuration"] for j in problem["jobs"] if j["divisionId"] == did and j["sourceBK"] == category)/3600 for did, _ in divisions]
        ax.bar([label for _, label in divisions], values, bottom=bottom, color=color, label=category)
        bottom = [a+b for a, b in zip(bottom, values)]
    ax.set_ylabel("Часы обслуживания, без дороги и ожидания")
    ax.set_title("Исходный объём работ для 203 новых заявок", loc="left", pad=14)
    ax.legend(loc="upper center", bbox_to_anchor=(0.5, -0.12), ncol=2, frameon=False)
    ax.spines[["top", "right"]].set_visible(False)
    fig.savefig(figdir / "input-workload.png", dpi=160)
    fig.savefig(figdir / "input-workload.svg")
    plt.close(fig)

    resolved = sum(bool(item.get("selected")) for item in cache.values())
    total_hours = sum(j["serviceDuration"] for j in problem["jobs"])/3600
    emergency_count = sum(j["isEmergency"] for j in problem["jobs"])
    lines = [
        "# Исследование оптимизаторов: проверка готовности", "",
        "**Промежуточный отчёт. Полный benchmark не выполнен. Победитель и shortlist не определены.**", "",
        "Дата проверки: 17.09.2026. Основные запуски всех десяти кандидатов имеют статус `BLOCKED_DATA`: ещё не разрешены неоднозначные адреса и не построена общая дорожная матрица. Измеренных сравнительных метрик решателей на кейсе пока нет. Установка и короткие примеры не включаются в сравнение качества.", "",
        "## Сценарий и проверка данных", "",
        "Владелец задал автомобиль у всех исполнителей и отсутствие перерывов. Для первого эксперимента объявлена общая смена 09:00–22:00. Заявки и квалификации взяты из отдельного исследовательского набора. Обслуживание — 70/80/20/30 минут по BK, без повторного добавления 20 минут дороги.", "",
        f"Вход: **203 новые заявки, 35 исполнителей, 3 подразделения**, {emergency_count} аварий HD «Авария». Суммарное обслуживание всех заявок: **{total_hours:.2f} ч** до добавления дороги и ожидания. Это объём спроса, а не выполненная решателем работа.", "",
        f"Проверены {len(cache)} уникальных адресов. Однозначно сопоставлены {resolved}; требуют решения {len(cache)-resolved}. [Полный список расхождений](reports/GEOCODING_REVIEW.md). Среди них два офиса: строение в исходнике и корпус в 2ГИС. Для Дубининской, 59 к2 найдено другое обозначение дома — 57Б. Такая замена не применена автоматически.", "",
        "![Готовность данных](reports/figures/data-readiness.png)", "",
        "![Объём обслуживания](reports/figures/input-workload.png)", "",
        "## Проверка перед каждым оптимизатором", "",
        "| Кандидат | Тип | Версия в локальном примере | Проверка установки | Основной набор |",
        "|---|---|---|---|---|",
    ]
    for candidate in candidates:
        sid = candidate["id"]
        check = next(c for c in checks if c["solver"] == sid)
        lines.append(f"| [{candidate['name']}]({candidate['repository']}) | {candidate['family']} | {check['testedSolverVersion'] or 'не запускалась'} | {check['smokeStatus']} | {check['dataStatus']} |")
    lines += ["", "Шесть кандидатов успешно выполнили небольшие полностью локальные примеры. VROOM, jsprit, Timefold и Choco пока не запускались: их runtime/build и адаптеры ещё не подготовлены. Это `NOT_RUN`, а не `UNSUPPORTED`. Python-окружение изолировано, зависимости зафиксированы.", "",
        "Версии SCIP и CBC указаны для фактически вызванного ядра, а не оболочки. На GitHub проверены также более новые релизы SCIP 10.0.3 и CBC 2.10.13; они не выдаются за протестированные версии. GitHub latest-release jsprit и опубликованная документация 2.0.0 расходятся, поэтому выбор артефакта ещё предстоит проверить.", "",
        "## Лицензии и источники", "",
        "Лицензии ниже относятся к открытым репозиториям. Коммерческие дополнения, облачные API оптимизации и функции Enterprise не включаются в возможности Community.", "",
        "| Кандидат | Лицензия | Документация |",
        "|---|---|---|",
    ]
    for candidate in candidates:
        lines.append(f"| {candidate['name']} | [{candidate['license']}]({candidate['repository']}) | [Официальный источник]({candidate['documentation']}) |")
    lines += ["", "Ссылки на проверенные релизы, commit SHA и время обращения сохранены в `registry/verified-registry.json`. Release reference и реально испытанная версия разделены. Все перечисленные библиотеки допускают локальный runtime; их применимость ко всем ограничениям именно этого кейса ещё проверяется.", "",
        "## Стенд и границы текущей проверки", "",
        "Созданы общий формат, проверка готовности до импорта адаптера, начальная версия независимого валидатора H01–H12 и отдельный расчёт метрик. Учитываются окна начала, открытые маршруты, смены, навыки, подразделения, транспорт, недоступные пути, защищённые посещения и неизменность переданной истории. Валидатор и модели динамики ещё подлежат проверке полным набором сценариев.", "",
        "Пройдена 21 проверка общего кода, геокодирования и малых примеров первого адаптера. Это не означает, что T01–T23 пройдены всеми решателями. Матрица T01–T23 содержит `NOT_RUN`; capability matrix содержит `NOT_CHECKED`, пока не накоплены отдельные доказательства.", "",
        "Реализован первый статический PRIMARY-адаптер OR-Tools Routing. Обнаружен дефект Windows-обёртки 9.15: `SetAllowedVehiclesForIndex` не принимает Python list. Использовано эквивалентное ограничение домена `VehicleVar` с сохранением значения -1 для неназначенной заявки. Подмена ограничений штрафами не используется.", "",
        "Доминирующие веса вычисляются из конечных границ: вес уровня равен 1 плюс максимум суммы всех нижних уровней. Для открытых маршрутов число физических дуг не превышает число обслуженных заявок, поэтому верхняя граница пробега — N × максимальная длина дуги. Переполнение целого диапазона проверяется. Политики аварий и динамика в первом адаптере ещё не реализованы.", "",
        "## Метрики, графики и суммарные результаты", "",
        "Сравнительных значений served, workersUsed, distance, response delay, времени поиска и устойчивости пока нет: основной набор не запускался. Пропуски не заменены нулями. Графики выше описывают готовность и входной спрос; они не показывают превосходство алгоритмов.", "",
        "После завершения опытов отдельные графики должны строиться для каждой числовой метрики из задания, с разделением по политике, подразделению, временному бюджету и версии матрицы. Для десяти seed рассчитываются best/median/worst/mean/std. Сводные показатели всей задачи берутся из общего плана на 203 заявки; результаты повторов нельзя суммировать как дополнительные заявки. Недопустимые планы показываются отдельно и не участвуют в ранжировании качества. Единого интегрального балла не будет.", "",
        "## Вывод на текущем этапе", "",
        "Данных пока недостаточно для честного сравнения оптимизаторов. Следующее обязательное решение — уточнить 12 адресов либо принять первые результаты 2ГИС как явно модельную географическую привязку тестового набора. После этого можно зафиксировать общие матрицы и переходить к адаптерам и запускам. Выбирать 2–3 лучших решения сейчас было бы преждевременно.", "",
        "Остаются: девять адаптеров, сценарии T01–T23 каждого кандидата, аварийные политики, динамика, бюджеты 1/5/15/60/300 секунд, десять seed, reference instances 5/10/15/20 и масштабирование 500/1000. Задание принято и начато, но не объявляется выполненным.", "",
        "[Как воспроизвести подготовку](README.md) · [Проверка данных JSON](results/preflight.json) · [Матрица тестов](results/test_matrix.csv)", "",
    ]
    (ROOT / "REPORT.md").write_text("\n".join(lines), encoding="utf-8")
    print(json.dumps({"dataStatus": preflight["status"], "uniqueAddresses": len(cache), "matchedAddresses": resolved,
                      "unresolvedAddresses": len(cache)-resolved, "serviceHours": total_hours,
                      "solversAudited": len(checks), "report": str(ROOT / "REPORT.md")}, ensure_ascii=False))


if __name__ == "__main__":
    main()
