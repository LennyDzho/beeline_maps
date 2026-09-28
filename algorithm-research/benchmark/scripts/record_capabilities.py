"""Evidence-linked implementation scope and reproducible source-size counts."""
import csv
import json
from datetime import datetime,timezone
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
FEATURES=["Time windows","Optional jobs","Worker skills","Transport compatibility","Heterogeneous workers","Individual shifts","Individual start locations","Open routes","External matrices","Multiple matrix profiles","Worker activation cost","Lexicographic objective","Emergency response objective","Warm start","Fixed activities","Protected prefix","Time limit","Return best feasible","Random seed","Diagnostics"]
NATIVE={
"ortools_routing":{"Time windows","Optional jobs","Individual shifts","Individual start locations","External matrices","Worker activation cost","Time limit","Return best feasible","Diagnostics"},
"vroom":{"Time windows","Optional jobs","Worker skills","Heterogeneous workers","Individual shifts","Individual start locations","Open routes","External matrices","Worker activation cost","Time limit","Return best feasible","Diagnostics"},
"jsprit":{"Time windows","Optional jobs","Worker skills","Heterogeneous workers","Individual start locations","Open routes","External matrices","Time limit","Return best feasible","Random seed","Diagnostics"},
"pyvrp":{"Time windows","Optional jobs","Heterogeneous workers","Individual shifts","Individual start locations","External matrices","Worker activation cost","Time limit","Return best feasible","Random seed","Diagnostics"},
"timefold":{"Optional jobs","Lexicographic objective","Warm start","Time limit","Return best feasible","Random seed","Diagnostics"},
"alns":{"Time limit","Random seed","Diagnostics"},
"cpsat":{"Time limit","Return best feasible","Random seed","Diagnostics"},
"scip":{"Time limit","Return best feasible","Random seed","Diagnostics"},
"cbc":{"Time limit","Return best feasible","Random seed","Diagnostics"},
"choco":{"Time limit","Return best feasible","Diagnostics"}}
EXTENDED={"ortools_routing","alns","timefold"}
WORKAROUNDS={
"ortools_routing":["VehicleVar domain instead of unsupported Windows SWIG Span argument","Open dummy sink","Proven integer dominance weights"],
"vroom":["Windows uint32 I buffer cast","One job skill encodes complete conjunctive eligibility","Fixed activation cost bounded over whole distance; 32-bit API guards"],
"jsprit":["Full-route hard insertion feasibility","Constant empty-route activation cost replaces progressive default","Exact objective includes bounded omission penalty","Null-vehicle callback uses shared car profile"],
"pyvrp":["Zero-capacity eligibility dimension per worker","Rescaled artificial loads for default penalty range","Open dummy depot","Unreachable arc sentinels exceed feasible bounds","Dominating prizes and activation costs"],
"timefold":["EasyScoreCalculator recomputes schedules","Protected anchors explicitly checked in hard score","SLF4J 1.7 transitive exclusion"],
"alns":["Custom feasible route state and earliest scheduling","Python integer hierarchy for emergency policies","Protected initial-state construction and repair"],
"cpsat":["Common arc-flow routing formulation","Tight bounded big-M time rows","Proven scalar hierarchy"],
"scip":["Common arc-flow routing formulation","Tight bounded big-M time rows","Exact-integer-range scalar for double objective"],
"cbc":["Common arc-flow routing formulation","Tight bounded big-M time rows","Exact-integer-range scalar for double objective","Explicit native MPS CLI plus watchdog","Cgl preprocessing disabled after observed crash"],
"choco":["Common arc-flow CP formulation","Sequential proved lexicographic stages","Table substitution disabled to avoid huge-domain bitsets"]}
NOTES={
"ortools_routing":"CP routing with parallel cheapest insertion and GLS; separate extended cumul response objective and native warm start. Routing LS seed not directly exposed by the parameter used here.",
"vroom":"Local official pyvroom binding. Native objective supports supplied costs, priorities and activation; a sum of selected emergency start times is not a documented input objective. Exact emergency/dynamic encoding not implemented; do not equate service_at in plan mode with a protected visit during search.",
"jsprit":"Ruin-and-recreate with custom objective and insertion constraints. Fixed/response modeling would need activity-time-aware insertion and ruin protection; this prototype tests static PRIMARY only.",
"pyvrp":"Version 0.14 uses iterated local search. Skills encoded as mathematical load constraints, not real capacity. CostEvaluator has a fixed compiled cost structure; custom per-emergency response optimization requires additional verified modeling or native extension. Dynamic adapter not implemented.",
"timefold":"Community 2.6.0, planning list and BendableScore; all domain constraints in our Java score calculator. Incremental scoring/custom moves not optimized. Enterprise multithreaded/partitioned solving is not used or required.",
"alns":"Framework, not a ready TRSP solver: all scheduling, eligibility, objective and destroy/repair behavior belong to this research implementation; operator maintenance is a material integration cost.",
"cpsat":"Generic integer CP/SAT reference, one search worker. Exact model is expressible, but performance depends strongly on routing formulation. Dynamic model not implemented.",
"scip":"Generic CIP/MIP reference via PySCIPOpt, portable wheel engine version 10.0.2; small-instance proofs, native bound recorded. Dynamic model not implemented.",
"cbc":"Generic MILP reference, official CBC 2.10.13 binary, serial main thread and CPU limit. Timed incumbent is FEASIBLE even if PuLP status says Optimal/solution found. Dynamic model not implemented.",
"choco":"Reified CP arc-flow; min unassigned, then crew, then distance in one shared budget. OPTIMAL only if all stages proved. Seed argument not used by selected search configuration; dynamic adapter not implemented."}
NOTES.update({
"ortools_routing":"Маршрутный CP-поиск: параллельная вставка и Guided Local Search. Отдельный расширенный адаптер задаёт задержки аварий через временные переменные и использует штатный warm start. Использованный параметр seed не подтверждает прямого управления случайностью локального поиска Routing.",
"vroom":"Локальная официальная обёртка pyvroom. Используются матрица стоимости, приоритеты и стоимость открытия маршрута. Сумма моментов начала выбранных аварий не является документированным входным критерием. Эквивалентные аварийные политики и защита действий не реализованы; service_at в режиме проверки готового плана не приравнивается к защите визита во время поиска.",
"jsprit":"Поиск с разрушением и восстановлением маршрутов, собственным критерием и проверками вставки. Для защиты действий и реакции аварий потребуется отдельная логика вставки с учётом времени и ограничения удаления визитов. Проверена только статическая политика PRIMARY.",
"pyvrp":"В версии 0.14 используется Iterated Local Search. Совместимость выражена через математические ограничения загрузки; они не добавляют реального ограничения грузоподъёмности. CostEvaluator имеет фиксированную структуру в скомпилированном ядре: для точной аварийной цели потребуется отдельно проверенное моделирование или расширение ядра. Динамический адаптер не реализован.",
"timefold":"Community 2.6.0: списки назначений и BendableScore. Все ограничения предметной области вычисляет наш Java-калькулятор оценки. Инкрементальный расчёт и специальные ходы ещё не оптимизированы. Коммерческие функции многопоточного и разделённого поиска не используются.",
"alns":"Это каркас поиска, а не готовый TRSP-решатель. Расписание, совместимость, целевые функции и операторы разрушения/восстановления реализованы в этом исследовании. Поддержка собственного планировщика и операторов составляет существенную часть стоимости внедрения.",
"cpsat":"Универсальный целочисленный CP/SAT-эталон, один поисковый поток. Постановка выражается точно, но скорость сильно зависит от потоковой маршрутной формулировки. Динамическая модель не реализована.",
"scip":"Универсальный CIP/MIP-эталон через PySCIPOpt, установленное ядро 10.0.2. Проверяются доказательства на малых экземплярах и сохраняются границы. Динамическая модель не реализована.",
"cbc":"Универсальный MILP-эталон, официальный бинарник CBC 2.10.13, один основной поток и ограничение CPU-времени. Допустимый incumbent на лимите получает FEASIBLE, даже если PuLP сообщает Optimal/solution found. Динамическая модель не реализована.",
"choco":"Потоковая CP-модель с условными временными ограничениями. Три последовательных этапа: неназначенные заявки, штат, пробег; общий бюджет времени. OPTIMAL возвращается только после доказательства всех этапов. Выбранная стратегия поиска не использует seed; динамический адаптер не реализован."})
SOURCES={
"ortools_routing":["https://developers.google.com/optimization/routing/routing_tasks","https://or-tools.github.io/docs/python/classortools_1_1constraint__solver_1_1pywrapcp_1_1RoutingDimension.html"],
"vroom":["https://github.com/VROOM-Project/vroom/blob/v1.15.0/docs/API.md","https://github.com/VROOM-Project/pyvroom"],
"pyvrp":["https://github.com/PyVRP/PyVRP/tree/v0.14.0/pyvrp","https://github.com/PyVRP/PyVRP/blob/v0.14.0/pyvrp/solve.py"],
"timefold":["https://docs.timefold.ai/timefold-solver/latest/using-timefold-solver/modeling-planning-problems","https://docs.timefold.ai/timefold-solver/latest/running-timefold-solver/multithreaded-solving"],
"choco":["https://choco-solver.org/docs/solving/limits/"]}


def main():
    candidates=json.loads((ROOT/"registry/verified-registry.json").read_text(encoding="utf-8"))
    test_path=ROOT/"results/test_matrix.json"
    tests=json.loads(test_path.read_text(encoding="utf-8")) if test_path.exists() else []
    rows=[];complexity=[]
    for c in candidates:
        sid=c["id"];c["adapterStatus"]="IMPLEMENTED_STATIC_PRIMARY"
        c["extendedAdapterStatus"]="IMPLEMENTED" if sid in EXTENDED else "NOT_IMPLEMENTED"
        for feature in FEATURES:
            status="DIRECT" if feature in NATIVE[sid] else "ADAPTER"
            note="Exercised by the source adapter and controlled/static cases"
            if feature=="Multiple matrix profiles":status="NOT_CHECKED";note="User selected car for every worker; simultaneous profiles not exercised"
            if feature in {"Emergency response objective","Warm start","Fixed activities","Protected prefix"} and sid not in EXTENDED:
                status="NOT_CHECKED";note="Not implemented in this adapter; not a proof of solver impossibility"
            if feature=="Random seed" and sid in {"ortools_routing","vroom","choco"}:
                status="NOT_CHECKED";note="Repeat identifier; direct control over this routing/search random stream not established"
            if feature=="Heterogeneous workers":note="Skills, shifts and starts vary; transport fixed to car by user"
            rows.append({"solver":sid,"feature":feature,"support":status,"note":note,"source":"; ".join(SOURCES.get(sid,[c["documentation"]])),"implementation":"adapters/"+sid+".py"})
        paths=[ROOT/f"adapters/{sid}.py"]
        if sid in EXTENDED:paths.append(ROOT/f"adapters/{sid}_extended.py")
        if sid in {"cpsat","scip","cbc","vroom","alns","ortools_routing"}:paths.append(ROOT/"adapters/linear_reference.py")
        if sid in {"jsprit","timefold","choco"}:
            java=ROOT/"adapters/java/src/main/java/research"
            paths += [ROOT/"adapters/java_bridge.py",java/"Bridge.java",java/({"jsprit":"JspritAdapter.java","timefold":"TimefoldAdapter.java","choco":"ChocoAdapter.java"}[sid])]
            if sid=="timefold":paths.append(java/"ExtendedBridge.java")
        loc={str(p.relative_to(ROOT)):sum(bool(line.strip()) and not line.lstrip().startswith(("#","//")) for line in p.read_text(encoding="utf-8").splitlines()) for p in dict.fromkeys(paths)}
        constraints=["same division","BK and all HD plus resources","transport match","start window and release","shift finish","sequence travel","at most one worker per job"]
        if sid in EXTENDED:constraints += ["fixed worker and exact visit times","unchanged committed history","current location and next availability"]
        groups=[r for r in rows if r["solver"]==sid]
        complexity.append({"solver":sid,"adapterLOC":sum(loc.values()),"LOCByFile":loc,"LOCDefinition":"Nonempty physical lines excluding pure # or // comments; shared code included in each affected adapter, so do not sum across methods",
            "customConstraintCount":len(constraints),"customConstraintGroups":constraints,"customOperatorsCount":4 if sid=="alns" else 0,
            "customOperatorsNote":"ALNS has two destroy and two repair families; native solver operators are not our custom code",
            "workaroundCount":len(WORKAROUNDS[sid]),"workarounds":WORKAROUNDS[sid],"nativeFeatureCount":sum(r["support"]=="DIRECT" for r in groups),
            "unsupportedFeatureCount":sum(r["support"]=="UNSUPPORTED" for r in groups),"notCheckedFeatureCount":sum(r["support"]=="NOT_CHECKED" for r in groups),
            "externalDependencies":"Portable Java 21 + Maven jars" if sid in {"jsprit","timefold","choco"} else "Python wheel + official CBC binary" if sid=="cbc" else "Python virtual environment and native wheels",
            "solverForkRequiredForImplementedScope":False,"cloudRequired":False,"implementationNotes":NOTES[sid]})
    for name,data in [("capability_matrix",rows),("integration_complexity",complexity)]:
        (ROOT/f"results/{name}.json").write_text(json.dumps(data,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
        with (ROOT/f"results/{name}.csv").open("w",encoding="utf-8-sig",newline="") as f:
            writer=csv.DictWriter(f,fieldnames=list(data[0]));writer.writeheader();writer.writerows([{k:json.dumps(v,ensure_ascii=False) if isinstance(v,(dict,list)) else v for k,v in r.items()} for r in data])
    (ROOT/"registry/verified-registry.json").write_text(json.dumps(candidates,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
    print(json.dumps({"features":len(rows),"methods":len(complexity),"checkedAt":datetime.now(timezone.utc).isoformat()}))


if __name__=="__main__":main()
