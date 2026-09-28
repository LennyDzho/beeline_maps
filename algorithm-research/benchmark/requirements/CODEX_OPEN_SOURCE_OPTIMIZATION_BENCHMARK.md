# Задача для Codex: исследование open-source алгоритмов оптимизации распределения заявок и маршрутизации

## 1. Цель

Необходимо провести воспроизводимое сравнительное исследование open-source алгоритмов и решателей для задачи распределения заявок между исполнителями и построения их маршрутов.

Исходные требования к задаче находятся в файле:

`ALGORITHM_RESEARCH_REQUIREMENTS(1).md`

Этот файл является основным источником бизнес-правил, ограничений, целевых функций, тестовых сценариев и метрик.

Основная задача исследования:

1. Найти и протестировать практически применимые open-source алгоритмы/решатели, которые:
   - могут работать полностью локально;
   - не требуют облачного сервиса для выполнения оптимизации;
   - доступны бесплатно;
   - имеют открытый исходный код и явную open-source лицензию;
   - потенциально способны решить исходную задачу без изменения её бизнес-смысла.

2. Реализовать единый экспериментальный стенд.

3. Прогнать все выбранные решатели на одинаковых данных, ограничениях, матрицах и временных бюджетах.

4. Сравнить результаты по единым внешним метрикам.

5. По результатам выбрать 2–3 лучших алгоритма/решателя для дальнейшего использования, желательно различающихся по внутреннему подходу к оптимизации.

Не выбирать победителя заранее. Итоговый shortlist должен формироваться только по результатам эксперимента.

---

## 2. Класс задачи

Исходная задача относится к комбинации:

- Technician Routing and Scheduling Problem, TRSP;
- Vehicle Routing Problem with Time Windows, VRPTW;
- open routes;
- heterogeneous workers/vehicles;
- skills;
- transport restrictions;
- optional jobs / unassigned jobs;
- worker shifts;
- different start locations;
- external travel-time and distance matrices;
- dynamic replanning;
- urgent/emergency request insertion;
- fixed/protected activities;
- warm start;
- lexicographic multi-objective optimization.

Не упрощать исходную постановку только ради возможностей конкретной библиотеки.

---

## 3. Обязательные кандидаты для первого этапа

Нужно исследовать и по возможности реализовать адаптеры как минимум для следующих решений.

### 3.1. Специализированные VRP / routing solvers

1. **Google OR-Tools Routing**
2. **VROOM**
3. **jsprit**
4. **PyVRP**

### 3.2. Constraint / planning solvers

5. **Timefold Solver Community**
6. **OR-Tools CP-SAT**
7. **Choco Solver**

### 3.3. Metaheuristic framework

8. **ALNS**

### 3.4. MIP / CIP / exact-reference solvers

9. **SCIP**
10. **CBC**

Допускается добавить другие актуальные open-source решения, если они:

- поддерживаются на текущий момент;
- имеют воспроизводимую установку;
- работают локально;
- имеют открытый исходный код;
- потенциально способны решать данную комбинацию routing/scheduling constraints.

Не добавлять заброшенные учебные проекты только ради увеличения списка.

Если конкретный solver не способен представить существенную часть требований без искажения задачи, это должно быть зафиксировано как результат исследования:

`UNSUPPORTED`

с точным объяснением, какое требование не поддерживается.

Не имитировать поддержку через некорректное изменение постановки.

---

## 4. Проверка лицензий и локального запуска

Для каждого кандидата зафиксировать:

- название;
- официальный репозиторий;
- официальный сайт/документацию;
- лицензию;
- текущую проверенную версию;
- tag/release/commit SHA;
- дату проверки;
- используемый язык/API;
- способ установки;
- возможность полностью локального запуска;
- наличие обязательных облачных зависимостей;
- ограничения Community/Open Source версии;
- наличие коммерческих функций, которые не входят в бесплатную версию.

Облачный бесплатный тариф не считается open-source локальным решением.

---

## 5. Единая архитектура benchmark

Необходимо создать единый внутренний формат задачи:

```text
ProblemInstance
├── workers
├── jobs
├── travelTimeMatrices
├── distanceMatrices
├── shifts
├── skills
├── transportModes
├── startLocations
├── serviceDurations
├── timeWindows
├── priorities
├── releaseTimes
├── fixedActivities
├── protectedActivities
└── previousSolution
```

Для каждого solver реализовать отдельный adapter:

```text
solve(
    problem,
    policy,
    time_limit,
    seed,
    initial_solution=None,
    fixed_activities=None
) -> SolutionResult
```

Все solver-specific особенности должны оставаться внутри адаптера.

---

## 6. Общий формат результата

Каждый адаптер должен преобразовывать native output решателя в единый формат:

```text
SolutionResult
├── status
├── routes
├── assignments
├── unassigned
├── timings
├── solverObjective
├── runtime
├── seed
├── solverVersion
└── rawDiagnostics
```

Native objective конкретного solver не использовать для сравнения алгоритмов между собой.

---

## 7. Независимый валидатор

Реализовать независимый валидатор, который не использует внутреннюю логику конкретного solver.

Validator должен самостоятельно проверить ограничения H01–H12 из `ALGORITHM_RESEARCH_REQUIREMENTS(1).md`.

План считается допустимым только при:

```text
hardViolations == 0
```

Никакой штраф в objective solver не может сделать нарушение hard constraint допустимым.

Валидатор должен возвращать:

```text
ValidationResult
├── totalHardViolations
├── H01
├── H02
├── ...
└── H12
```

и подробный список нарушений.

---

## 8. Основная целевая функция

Для первичного плана использовать строгий лексикографический порядок:

```text
1. maximize served
2. при том же served: minimize workersUsed
3. при тех же served и workersUsed: minimize distance
```

Нельзя ухудшить `served` ради уменьшения числа исполнителей или пробега.

Нельзя ухудшить `workersUsed` ради уменьшения пробега.

Если solver поддерживает настоящие multi-level / lexicographic objectives, использовать их.

Если solver поддерживает только scalar objective, допускается преобразование в weighted objective только при математически доказанном доминировании уровней.

Запрещены произвольные magic weights вроде:

```text
1000000
10000
100
```

без доказательства сохранения лексикографического порядка.

---

## 9. Экспериментальные политики аварий

Реализовать две политики из требований.

### POLICY_FAST_RESPONSE

```text
1. total coverage
2. emergency coverage
3. minimum emergency response delay
4. minimum workers used
5. minimum distance
```

### POLICY_MIN_STAFF

```text
1. total coverage
2. emergency coverage
3. minimum workers used
4. minimum emergency response delay
5. minimum distance
```

Для каждой аварии считать:

```text
responseDelay = plannedStart - releaseTime
completionDelay = plannedFinish - releaseTime
```

Priority/penalty за неназначение аварии не считается эквивалентом минимизации response delay.

---

## 10. Общие метрики

Все метрики должны рассчитываться отдельным единым модулем после независимой валидации результата.

### 10.1. Допустимость

```text
hardViolations
H01Violations
...
H12Violations
```

### 10.2. Основное качество решения

```text
jobsTotal
served
unassigned
servedPercent
workersUsed
distanceKm
travelMinutes
waitingMinutes
serviceMinutes
```

### 10.3. Аварии

```text
emergencyTotal
emergencyServed
emergencyUnassigned

responseDelay per emergency
completionDelay per emergency

meanResponseDelay
medianResponseDelay
maxResponseDelay

meanCompletionDelay
maxCompletionDelay
```

### 10.4. Перепланирование

```text
reassignments
workerChanges
orderChanges
scheduleChanges
removedAssignments
newWorkersActivated
maxScheduleShiftMinutes
```

### 10.5. Производительность

```text
solverWallTimeMs
solverCpuTimeMs            # если возможно корректно измерить
validationTimeMs
matrixPreparationTimeMs
peakMemoryMb
solverStatus
optimalityGap              # если solver умеет
bestBound                  # если доступно
seed
```

### 10.6. Воспроизводимость

```text
solverVersion
commitSha
adapterVersion
datasetVersion
matrixVersion
parameters
objectivePolicy
seed
timestamp
```

---

## 11. Не создавать единый интегральный score

Не сводить результаты к одному условному баллу.

Недопустимо:

```text
OR-Tools = 92
VROOM = 87
Timefold = 84
```

Сравнение должно оставаться многокритериальным.

В первую очередь анализировать:

1. допустимость;
2. served;
3. workersUsed;
4. distance;
5. emergency response;
6. устойчивость результата;
7. время решения;
8. сложность интеграции.

---

## 12. Оценка сложности интеграции

Для каждого адаптера дополнительно зафиксировать:

```text
adapterLOC
customConstraintCount
customOperatorsCount
workaroundCount
nativeFeatureCount
unsupportedFeatureCount
externalDependencies
implementationNotes
```

По возможности также оценить:

- объём собственного кода;
- необходимость патчей solver;
- необходимость форка;
- сложность поддержки;
- сложность моделирования fixed/protected activities;
- сложность warm start;
- сложность динамического перепланирования.

---

## 13. Этапы эксперимента

### Этап 1. Проверка установки

Для каждого solver:

1. установить;
2. запустить минимальный example;
3. записать версию;
4. проверить полностью локальный режим;
5. зафиксировать license;
6. подтвердить воспроизводимость запуска.

---

### Этап 2. Capability matrix

Для каждого кандидата построить таблицу:

| Возможность | Direct | Adapter | Unsupported | Not checked |
|---|---:|---:|---:|---:|
| Time windows | | | | |
| Optional jobs | | | | |
| Worker skills | | | | |
| Transport compatibility | | | | |
| Heterogeneous workers | | | | |
| Individual shifts | | | | |
| Individual start locations | | | | |
| Open routes | | | | |
| External matrices | | | | |
| Multiple matrix profiles | | | | |
| Worker activation cost | | | | |
| Lexicographic objective | | | | |
| Emergency response objective | | | | |
| Warm start | | | | |
| Fixed activities | | | | |
| Protected prefix | | | | |
| Time limit | | | | |
| Return best feasible | | | | |
| Random seed | | | | |
| Diagnostics | | | | |

---

## 14. Regression tests T01–T23

Реализовать все сценарии T01–T23 из исходного файла как автоматические тесты.

Для каждого solver зафиксировать:

```text
PASS
FAIL
UNSUPPORTED
```

`FAIL` и `UNSUPPORTED` — разные состояния.

Если solver выдал решение, но независимый validator обнаружил нарушение, результат:

```text
FAIL_INVALID_SOLUTION
```

---

## 15. Основной реальный dataset

После прохождения базовых тестов выполнить расчёт на исходной постановке:

```text
203 новых заявки
35 исполнителей
3 подразделения
```

Отдельно:

```text
Восток
Юго-восток
Югоцентр
```

затем общий запуск.

Назначения между подразделениями запрещены.

---

## 16. Временные бюджеты

Для эвристических и metaheuristic solver выполнить исследования при одинаковых time limits:

```text
1 s
5 s
15 s
60 s
300 s
```

Это экспериментальные бюджеты, а не SLA продукта.

Для каждого бюджета сохранять лучший найденный допустимый результат.

Для exact solver фиксировать:

- incumbent;
- best bound;
- gap;
- статус при завершении time limit.

---

## 17. Random seeds

Для solver с недетерминированным поведением использовать минимум:

```text
seed = 1
seed = 2
seed = 3
seed = 4
seed = 5
seed = 6
seed = 7
seed = 8
seed = 9
seed = 10
```

Для каждой конфигурации рассчитывать:

```text
best
median
worst
mean
std
```

по основным метрикам.

Особенно контролировать разброс:

- served;
- workersUsed;
- distance;
- emergency response delay;
- runtime.

---

## 18. Dynamic replanning

После первичного расчёта сохранить исходный plan snapshot.

Протестировать события:

1. новая срочная авария;
2. отмена заявки;
3. недоступность исполнителя;
4. ручное изменение назначения;
5. ручное изменение времени.

При перепланировании:

- прошлое не изменять;
- `en_route` не переставлять;
- `in_progress` не переставлять;
- protected/confirmed visit не изменять автоматически;
- учитывать актуальное положение исполнителя;
- учитывать момент его следующей доступности;
- использовать предыдущий plan как warm start, если solver это допускает.

---

## 19. Масштабирование

После основного dataset провести синтетические тесты:

```text
500 jobs
1000 jobs
```

Синтетические наборы должны быть явно отделены от исходных данных.

Сохранять:

- число jobs;
- число workers;
- число divisions;
- плотность time windows;
- skills distribution;
- transport distribution;
- matrix size;
- seed генерации dataset.

---

## 20. Reference / exact comparison

CP-SAT, SCIP, CBC, Choco и другие generic exact/constraint методы необязательно должны решать полный dataset быстрее специализированных VRP solver.

Их дополнительная роль:

- малые exact instances;
- проверка оптимальности;
- получение bound;
- проверка качества эвристик.

Создать отдельный набор небольших экземпляров, например:

```text
5 jobs
10 jobs
15 jobs
20 jobs
```

где возможно получить доказанный optimum или качественный bound.

Использовать эти результаты для проверки специализированных heuristics/metaheuristics.

---

## 21. ALNS

Для ALNS реализовать отдельную экспериментальную модель, если это разумно по объёму работ.

Рекомендуемые destroy operators:

```text
randomRemoval
worstRemoval
relatedRemoval
routeTailRemoval
timeRelatedRemoval
emergencyNeighbourhoodRemoval
highResponseDelayRemoval
workerRouteRemoval
```

Рекомендуемые repair operators:

```text
greedyInsertion
earliestFeasibleInsertion
regret2Insertion
regret3Insertion
skillAwareInsertion
crossWorkerInsertion
emergencyEarliestInsertion
```

Предыдущий solution должен использоваться как initial state.

Не разрабатывать сложный ALNS до получения baseline результатов готовых solver.

---

## 22. Выходные файлы

Создать следующую структуру:

```text
benchmark/
├── README.md
├── requirements/
├── datasets/
├── matrices/
├── core/
│   ├── problem_model.*
│   ├── solution_model.*
│   ├── validator.*
│   └── metrics.*
├── adapters/
│   ├── ortools_routing/
│   ├── vroom/
│   ├── jsprit/
│   ├── pyvrp/
│   ├── timefold/
│   ├── alns/
│   ├── cpsat/
│   ├── choco/
│   ├── scip/
│   └── cbc/
├── tests/
│   ├── T01.*
│   ├── ...
│   └── T23.*
├── results/
│   ├── raw/
│   ├── benchmark_results.csv
│   ├── benchmark_results.json
│   ├── capability_matrix.csv
│   └── test_matrix.csv
└── REPORT.md
```

---

## 23. Формат benchmark_results.csv

Минимальные колонки:

```text
solver
solverVersion
commitSha
dataset
policy
timeLimitSec
seed

status
hardViolations

jobsTotal
served
unassigned
servedPercent

workersUsed
distanceKm
travelMinutes
waitingMinutes
serviceMinutes

emergencyTotal
emergencyServed
meanResponseDelay
medianResponseDelay
maxResponseDelay
meanCompletionDelay
maxCompletionDelay

reassignments
workerChanges
orderChanges
scheduleChanges
newWorkersActivated
maxScheduleShiftMinutes

solverWallTimeMs
validationTimeMs
peakMemoryMb

bestBound
optimalityGap

adapterLOC
workaroundCount
unsupportedFeatureCount
```

---

## 24. Итоговый REPORT.md

Отчёт должен содержать:

### 24.1. Кандидаты

Для каждого:

- описание алгоритма;
- лицензия;
- версия;
- архитектура;
- язык/API;
- локальный запуск;
- ограничения OSS edition.

### 24.2. Capability matrix

Показать:

```text
DIRECT
ADAPTER
UNSUPPORTED
NOT_CHECKED
```

### 24.3. T01–T23

Матрица прохождения тестов.

### 24.4. Основной dataset

Сравнение всех допустимых решений.

### 24.5. Quality vs time

Для каждого solver построить зависимости от time budget:

- served;
- workersUsed;
- distance;
- emergency response;
- runtime.

### 24.6. Stability

Для stochastic solver:

- best;
- median;
- worst;
- std.

### 24.7. Replanning

Сравнить способность реагировать на события рабочего дня.

### 24.8. Scaling

Сравнить:

```text
203
500
1000
```

jobs.

### 24.9. Integration complexity

Отдельная таблица сложности реализации и поддержки.

---

## 25. Правила выбора финальных 2–3 решений

Не выбирать исключительно по минимальному расстоянию.

Сначала исключить solver, которые:

1. регулярно нарушают hard constraints;
2. не позволяют корректно представить существенные требования;
3. имеют неприемлемую нестабильность;
4. не масштабируются до рабочего dataset;
5. требуют облачного runtime;
6. требуют коммерческой лицензии для критически необходимого функционала.

Из оставшихся определить 2–3 наиболее полезных решения.

Желательно сохранить разные алгоритмические подходы.

Например, если результаты это оправдывают:

```text
1 specialized VRP solver
1 constraint/planning solver
1 custom/metaheuristic solver
```

Не выбирать три почти идентичных алгоритма только потому, что их результаты отличаются на несколько километров.

---

## 26. Принцип финального анализа

Финальный вывод должен отвечать на вопросы:

1. Какие open-source solver реально способны решить исходную задачу?
2. Какие требования они поддерживают непосредственно?
3. Где нужен adapter/workaround?
4. Какие требования невозможно корректно выразить?
5. Кто даёт максимальное покрытие?
6. Кто при одинаковом покрытии использует меньше исполнителей?
7. Кто при одинаковом покрытии и штате даёт меньший пробег?
8. Кто лучше реагирует на аварии?
9. Кто лучше перепланирует существующий план?
10. Кто быстрее?
11. Кто стабильнее между seeds?
12. Кто лучше масштабируется?
13. Какова цена интеграции каждого решения?
14. Какие 2–3 решения рационально оставить в проекте?

---

## 27. Важные ограничения исследования

Запрещается:

- менять бизнес-правила под возможности solver;
- скрывать hard constraint violation штрафом;
- использовать разные matrices для разных solver;
- сравнивать native objective разных solver напрямую;
- использовать разные исходные datasets;
- скрыто исключать сложные заявки;
- считать ненайденное решение доказательством невозможности;
- выдавать heuristic solution за доказанный optimum;
- использовать произвольные objective weights без доказательства;
- смешивать время построения матриц и solver runtime;
- считать коммерческую функцию частью open-source edition;
- использовать облачный сервис как обязательную часть решения.

---

## 28. Приоритет реализации

Работать итерационно.

### Итерация 1

Создать:

- common models;
- validator;
- metrics;
- dataset loader;
- benchmark runner.

### Итерация 2

Подключить готовые специализированные solver:

1. OR-Tools Routing;
2. VROOM;
3. jsprit;
4. PyVRP.

### Итерация 3

Подключить:

5. Timefold;
6. ALNS.

### Итерация 4

Reference solvers:

7. CP-SAT;
8. Choco;
9. SCIP;
10. CBC.

Если какой-либо solver требует непропорционально большого объёма адаптации, сначала выполнить capability analysis и зафиксировать это в отчёте, а не задерживать весь benchmark.

---

## 29. Главный критерий корректности

Любой результат solver должен проходить один и тот же независимый validator.

Только после:

```text
hardViolations == 0
```

разрешено сравнивать качество решения.

Исходный файл `ALGORITHM_RESEARCH_REQUIREMENTS(1).md` имеет приоритет над предположениями разработчика, примерами из документации solver и удобством конкретной библиотеки.
