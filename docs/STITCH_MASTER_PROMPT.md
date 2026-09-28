# Мастер-промпт для Google Stitch

Промпт написан на английском, потому что генераторы интерфейсов обычно точнее выполняют сложные структурированные инструкции на английском. Весь пользовательский текст внутри интерфейса должен быть на русском языке.

```text
Create a complete, coherent, production-oriented multi-screen UI/UX design for a field service scheduling product called “Марш!”. Do not create only a single dashboard. Build one shared design system and two clearly separated client experiences:

1. A responsive desktop web application for organization administrators and dispatchers.
2. A native-looking Android mobile application for field performers/engineers.

All visible interface copy, labels, statuses, notifications, sample data, validation messages and empty states must be in Russian. Use realistic Russian addresses, names, dates, phone formats and operational terminology. The product is for scheduling service visits, assigning engineers, optimizing routes, managing qualifications/resources and controlling field execution.

IMPORTANT PRODUCT BOUNDARIES

- This is NOT a CRM.
- Do not add leads, sales pipelines, deals, commissions, revenue dashboards, customer acquisition metrics or financial funnels.
- The web application uses its own email/password login. Do not show “Sign in with OpenAI”, Google social login or open self-registration.
- Mobile performer registration is invitation-only and uses phone verification with OTP.
- A user account, an employee/performer record and organization membership are separate concepts.
- Permissions are role-based and organization-scoped.
- The map is a visualization and navigation layer, not the source of business rules.
- The scheduling engine owns skills, shifts, equipment, vehicles, time windows, SLA rules and protected visits.
- A visit already confirmed with a customer cannot be automatically changed. The optimizer may suggest a change, but a dispatcher must explicitly confirm that the customer was contacted before the new schedule can be applied.
- Clearly separate the base MVP from the optional FSM reporting and external AI verification module described later.

PRODUCT ROLES

- platform_admin: platform operations and emergency administration; not part of normal organization workflow.
- org_admin: organization settings, users, roles, work types, integrations, audit and resources.
- dispatcher: requests, performers, planning, manual corrections, plan publication and customer communication.
- performer: only their own visits, route, allowed status transitions, profile and devices in Android.

VISUAL DIRECTION

Create a calm, trustworthy, modern Russian B2B operations product. It should feel professional, precise and human, not like a generic AI dashboard.

- Product name: “Марш!”.
- Descriptor: “Диспетчерская” for web and “Исполнитель” for mobile.
- Primary dark forest color: #103A2D.
- Primary action green: #174A3A.
- Warm accent gold: #F2C56B.
- Main background: #F3F5F4.
- White surfaces: #FFFFFF.
- Primary text: #17232D.
- Secondary text: #6E7B86.
- Borders: #E3E8EA.
- Route colors: orange #E26B36, blue #4169A8, green #2E8065, plus accessible additional colors when needed.
- Error: muted red; warning: amber; success: green; informational: blue.
- Use Inter or a similar highly legible sans-serif with full Cyrillic support.
- Use a consistent 4/8 px spacing system, 10–12 px card radii, subtle shadows and clear hierarchy.
- Avoid glassmorphism, neon colors, excessive gradients, decorative 3D graphics and oversized empty areas.
- Do not use tiny text. Body text should normally be 14–16 px on web and at least 14 sp on Android.
- Use recognizable outline icons. Do not use isolated letters as final navigation icons.
- Color must never be the only carrier of status; combine color, text and icon.
- Meet accessible contrast, keyboard focus, touch target and form-label requirements.

SHARED DESIGN SYSTEM

Create reusable design tokens and component variants rather than unique one-off blocks. Include:

- application shell, side navigation, top bar and mobile bottom navigation;
- page header, breadcrumbs, date picker and organization switcher placeholder;
- buttons: primary, secondary, tertiary, danger, icon-only, loading and disabled;
- text fields, password fields, phone input, OTP input, selects, autocomplete, date/time fields and search;
- checkboxes, radio groups, switches, segmented controls and chips;
- cards, metric cards, route cards, visit cards, employee cards and resource cards;
- data tables with sorting, filtering, pagination and row selection;
- status badges with icon and text;
- tabs, accordions, stepper, timeline and progress indicator;
- toast, inline alert, notification banner and confirmation banner;
- modal, side drawer, bottom sheet and destructive confirmation dialog;
- map pins, clustered pins, route polylines, route legend and map controls;
- skeleton, loading, empty, offline, error, no-permission and conflict states;
- file/photo/video upload cards with upload/scanning/ready/failed states;
- audit timeline and before/after change comparison.

WEB APPLICATION

Design the desktop web application at 1440×900 and make it responsive down to 1024 px. Use a fixed dark-green left sidebar around 228–240 px wide and a light operational workspace. Main navigation:

- “Планирование”
- “Заявки”
- “Исполнители”
- “Ресурсы”
- “Отчёты” — operational performance only, never CRM or sales
- “Проверка отчётов” — mark as optional FSM module
- “Администрирование” — visible to org_admin

At the bottom of the sidebar show system health, current user, role and a clear “Выйти” action.

WEB SCREEN 1 — EMAIL/PASSWORD LOGIN

Create a polished responsive login screen using the same forest/gold identity.

- Heading: “Вход в диспетчерскую”.
- Supporting text: “Введите рабочий email и пароль, выданные администратором.”
- Fields: “Email”, “Пароль”, password visibility toggle.
- Primary action: “Войти”.
- Footer hint: “Нет доступа? Обратитесь к администратору проекта.”
- Show generic invalid credentials error without revealing whether an account exists.
- Show a temporary lockout state after too many failed attempts.
- No social login and no self-registration.

WEB SCREEN 2 — DAILY PLANNING WORKSPACE

This is the primary dispatcher screen.

Header:

- eyebrow “Операционный день”;
- title “Планирование выездов”;
- selected date with “Сегодня” and a Russian date;
- notifications icon;
- plan state “Черновик плана”, “План пересчитан” or “План опубликован”;
- last modified time;
- actions “Пересчитать” and “Опубликовать план”.

Summary metrics:

- “Заявки на сегодня”;
- “Запланировано” with assigned/total;
- “Исполнители” with available/total;
- “Время в пути” and improvement after optimization;
- optionally “Риски SLA” and “Без исполнителя”, without overcrowding the row.

Main workspace:

- tabs “Карта и маршруты” and “Все заявки”;
- filters for performer, status, area, skill, time window and SLA risk;
- left side: scrollable routes grouped by engineer;
- right side: a Moscow map prepared for a 2ГИС map layer;
- colored route polyline and numbered stops for every engineer;
- legend with engineer names and colors;
- map controls, fit routes, layers and current selection;
- do not hardwire business logic to the map UI.

Engineer route group:

- avatar, full name, role, shift, load percentage and route duration;
- skills/clearance chips where relevant;
- ordered visit cards with time window, work type, address and status;
- status examples: “Подтверждён”, “Запланирован”, “Риск SLA”, “Требует согласования”;
- click opens the visit detail drawer.

Unassigned block:

- title “Без исполнителя” with count;
- reason on every card: no matching skill, no vehicle, equipment conflict, time-window conflict or capacity limit;
- primary next action or link to conflict details;
- after successful optimization show a positive empty state.

WEB SCREEN 3 — VISIT DETAIL DRAWER

Show:

- request number, work type, priority and operational status;
- customer time window and address;
- expected service duration;
- assigned performer and reason for assignment;
- required skills, clearance, vehicle and equipment;
- SLA indicators;
- customer confirmation state;
- route position and travel time;
- audit/history timeline;
- actions appropriate to the current role and state.

Explain assignments in plain language, for example: “Исполнитель подходит по квалификации, находится ближе других и успевает в заданное временное окно.” Never show raw optimization-provider output as the explanation.

WEB SCREEN 4 — OPTIMIZATION RESULT AND CONFLICT REVIEW

Create a review state shown after “Пересчитать”, before publication:

- before/after summary: assigned visits, travel time, SLA risks and unresolved conflicts;
- list of proposed changes grouped by engineer;
- old and new route/time comparison;
- reasons for every move;
- warnings for missing skills/resources/time windows;
- ability to accept safe changes or inspect conflicts;
- the current published plan remains visibly authoritative until approval and publication.

Protected customer-confirmed visit behavior:

- show a lock icon and badge “Подтверждено клиенту”;
- optimizer suggestion cannot be applied automatically;
- approval modal shows old time/performer, proposed time/performer and reason;
- mandatory checkbox “Клиент уведомлён и согласовал изменение”;
- mandatory text field “Причина изменения”;
- buttons “Оставить текущий план” and “Подтвердить изменение”;
- record who confirmed and when;
- until confirmation, the old schedule remains active.

WEB SCREEN 5 — REQUESTS

Create a dense but readable operational table/list:

- search by number, address and customer;
- filters: date, status, priority, area, work type, assigned performer, SLA risk and confirmation state;
- columns: request, work type, time window, address, performer, required skills/resources, priority, SLA and status;
- saved filter presets can be visually suggested but do not need full implementation;
- create/edit request drawer with address geocoding suggestions and explicit coordinate state;
- bulk selection only for actions that are safe and role-allowed;
- empty, loading, API error and no-result states.

WEB SCREEN 6 — PERFORMERS

Create list and detail views:

- name, employee number, phone verification status, current status and availability;
- today’s load, shift, base/start location and current assignments;
- verified qualifications, levels, clearances and expiration warnings;
- assigned vehicle/equipment;
- mobile installation and notification availability;
- invitation states: created, sent, accepted, expired, revoked;
- actions “Создать исполнителя”, “Отправить приглашение”, “Повторить приглашение”, “Заблокировать” and “Изменить график” according to role;
- profile mismatch/correction request queue with current data, proposed data, comment and dispatcher resolution;
- never let a performer self-assign roles or qualifications.

WEB SCREEN 7 — RESOURCES

Create separate tabs for “Транспорт” and “Оборудование”:

- availability, assignment, maintenance state and time interval;
- conflicts in the daily plan;
- whether a resource is permanently assigned, shift-assigned or from a shared pool;
- resource detail with upcoming reservations and audit history;
- use neutral wording where business policy is not yet finalized.

WEB SCREEN 8 — OPERATIONAL REPORTS

This is not a sales or CRM dashboard. Show operational metrics only:

- visits planned/completed/cancelled;
- SLA compliance;
- average travel and service time;
- performer utilization;
- unassigned reasons;
- rescheduling count, including customer-confirmed overrides;
- notification delivery/ack health where appropriate;
- filters by period, team, performer, work type and status;
- export action can be present visually.

WEB SCREEN 9 — ADMINISTRATION AND ACCESS

Use tabs or nested navigation:

- “Пользователи и роли”;
- “Приглашения”;
- “Организация”;
- “Виды работ”;
- “Интеграции”;
- “Устройства”;
- “Аудит”.

Show organization-scoped roles and clear permission descriptions. Design:

- invite dispatcher by corporate email;
- create performer record before mobile activation;
- invitation history and expiry/revocation;
- verified phone/email indicators;
- active and revoked sessions/devices;
- immutable audit list with actor, action, object, old/new values, reason and server time;
- no secret tokens or credentials visible in the UI.

ANDROID APPLICATION

Create a native-looking Android experience for 360×800 and 412×915. Follow Material 3 interaction conventions while preserving the “Марш!” brand. Use edge-to-edge layouts, 48 dp minimum touch targets, clear system bars and realistic Android bottom sheets/dialogs. Main working navigation after onboarding:

- “Сегодня”
- “Уведомления”
- “Профиль”

MOBILE SCREEN 1 — INVITATION WELCOME

- logo and title “Марш! · Исполнитель”;
- explain that access is available only by organization invitation;
- accept data-processing terms;
- phone input using Russian format;
- action “Получить код”;
- alternative App Link state when invitation token is already present;
- if invitation is missing or invalid, do not offer open registration; show “Обратитесь к диспетчеру”.

MOBILE SCREEN 2 — OTP

- 6-digit code input;
- masked phone;
- resend countdown;
- incorrect, expired and too-many-attempts states;
- action “Подтвердить”;
- responses must not disclose whether an unknown phone belongs to an employee.

MOBILE SCREEN 3 — PROFILE CONFIRMATION

Show a minimal work profile:

- ФИО;
- организация;
- табельный номер;
- должность;
- phone verified indicator.

Actions:

- “Данные верны”;
- “Сообщить об ошибке”.

Correction form must collect a comment and proposed correction without presenting it as an immediate change. Show pending dispatcher review and a version-conflict state when the profile changed on the server.

MOBILE SCREEN 4 — NOTIFICATION PERMISSION EDUCATION

Before the Android system permission dialog, explain why schedule updates and urgent changes require notifications. Actions “Разрешить уведомления” and “Не сейчас”. Refusal must not block the app. If Google Play services or permission is unavailable, show a calm warning and keep manual synchronization available.

MOBILE SCREEN 5 — TODAY

Primary performer home screen:

- date and greeting;
- online/offline/sync state;
- current shift and total visits;
- next visit highlighted;
- ordered daily timeline/list;
- compact route map or “Показать маршрут” switch;
- visit cards with time window, address, work type, duration, status and urgent change indicator;
- manual “Синхронизировать” action;
- offline banner “Данные доступны офлайн. Изменения будут отправлены после восстановления сети.”;
- notification-disabled banner that is informative but not blocking.

MOBILE SCREEN 6 — VISIT DETAIL

Show only the assigned performer’s visit:

- work type, request number, time window and priority;
- address and external navigation action “Открыть навигатор”;
- service duration;
- required skills, equipment and vehicle;
- operational instructions and safe contact information;
- route position and travel estimate;
- status timeline;
- allowed primary action based on the current state.

Design status actions for the provisional MVP state machine:

- “Принять назначение”;
- “Выехал”;
- “Прибыл”;
- “Начать работу”;
- “Работа завершена”;
- exception action “Сообщить о проблеме” with reason;
- also show cancelled/no-access handling as exceptional states.

Do not expose impossible transitions. When an offline action is queued, show “Сохранено на устройстве” rather than pretending it was accepted by the server. Design version-conflict resolution where the server state wins and the user receives a clear explanation.

MOBILE SCREEN 7 — NOTIFICATIONS

Create a server-backed notification inbox with categories:

- new assignment;
- rescheduled visit;
- cancelled visit;
- route updated;
- reminder;
- profile action required;
- session/device revoked;
- optional FSM report returned/accepted.

Do not show sensitive customer address in the notification preview. Opening a notification must lead to the current authorized entity state.

MOBILE SCREEN 8 — PROFILE AND DEVICES

- work profile and verification state;
- qualifications shown as organization-verified, read-only badges;
- active mobile device, last sync and notification status;
- logout and “Завершить все сеансы” actions;
- profile correction request state;
- app version and support contact.

OPTIONAL FSM MODULE — KEEP VISUALLY SEPARATE FROM BASE MVP

Create these screens as a clearly labeled future/optional module. Do not make them required for the core planning flow.

OPTIONAL MOBILE FSM — REPORT DRAFT

After physical work is finished, create a schema-driven report experience:

- checklist, text, number, select and materials-used fields;
- conditional required fields;
- performer comment;
- progress summary of required evidence;
- one-time foreground location capture at arrival and report submission, not continuous tracking;
- reference object coordinate and actual coordinate status shown separately;
- geo anomaly state may require a reason rather than silently changing the reference coordinate.

OPTIONAL MOBILE FSM — PHOTO/VIDEO EVIDENCE

Categories: “До работ”, “После работ”, “Серийный номер”, “Дефект”, “Общий вид”.

- camera-only or camera/gallery source according to policy;
- photo/video count requirements;
- upload lifecycle: local, uploading, scanning, ready, failed/rejected;
- offline state “Сохранено на устройстве, ещё не отправлено”;
- resumable progress and retry;
- report cannot be submitted until required assets are server-ready;
- submitted revision and evidence become immutable;
- returned report creates revision N+1 and preserves history.

OPTIONAL WEB FSM — REVIEW QUEUE

Queue columns and filters:

- waiting time and SLA;
- performer, object, work type and requirement version;
- required evidence completeness;
- geo distance, accuracy and anomaly;
- routing source: manual, AI not accepted or AI technical error;
- previous returns and revision number;
- filters by team, work type, date, routing source, geo anomaly, repeated revision and SLA breach.

OPTIONAL WEB FSM — REPORT REVIEW CARD

- request and actual visit times;
- completed form and checklist;
- reference and captured points on a map;
- categorized photo gallery and video player;
- revision and decision timeline;
- external verifier result summary when present;
- actions “Принять”, “Вернуть на доработку”, “Отклонить”;
- return/reject requires a reason and may target specific fields/evidence categories;
- prevent self-review;
- accepted revision is immutable.

OPTIONAL WEB FSM — WORK TYPE VERSIONING

Path: “Администрирование → Виды работ”.

Create a multi-step editor:

1. Basic work type information.
2. Report template fields and checklist.
3. Geo policy: required events, accuracy, radius and anomaly handling.
4. Media policy: category, photo/video, min/max count, source, size/duration and verifier inclusion.
5. Reviewer: dispatcher or one active organization AI connection.
6. Review changes and publish immutable version.

Changing requirements creates a new version and does not rewrite historical visits.

OPTIONAL WEB FSM — EXTERNAL AI CONNECTIONS

This product does not train or supply a domain AI model. The customer can add its own API connection.

- org_admin can add connection name, endpoint, authentication settings, timeout and retry count;
- secret value is entered once, masked and never displayed again;
- show connection status, “Проверить подключение” and emergency disable/kill switch;
- dispatcher cannot edit endpoints or secrets;
- reviewer selection is exactly one of “Диспетчер” or “Внешняя AI-модель”;
- AI result is only “accepted” or “not accepted”; timeout, invalid response and technical failure route the report to manual dispatcher review;
- only accepted automatically closes the accounting task.

GLOBAL STATES TO DESIGN

For all important screens, include representative variants:

- default with realistic data;
- loading/skeleton;
- empty;
- filtered no-results;
- validation error;
- API/network error with retry;
- offline/queued sync on Android;
- permission denied;
- stale/version conflict;
- success confirmation;
- disabled action with explanation;
- destructive confirmation;
- role-limited read-only state.

REALISTIC SAMPLE DATA

Use a coherent Moscow demo day, not random unrelated cards:

- Date: “20 августа, четверг”.
- Dispatcher: “Ольга Дроздова” or current admin “Администратор MMI”.
- Engineers: Алексей Иванов, Марина Соколова, Илья Козлов.
- Example requests: A-1428 “Диагностика оборудования”, A-1431 “Плановое обслуживание”, A-1424 “Замена блока питания”, A-1436 “Пусконаладочные работы”, A-1419 “Проверка линии связи”, A-1433 “Аварийный выезд”, A-1438 “Настройка контроллера”.
- Example addresses: ул. Академика Королёва, 12; Дмитровское ш., 64; Ленинградский пр-т, 37; ул. Большая Дмитровка, 15; ул. Шаболовка, 31; Варшавское ш., 125; ул. Профсоюзная, 76.
- Skills: “Диагностика”, “ТО”, “Электрика”, “Монтаж”, “Сети”, “Автоматика”.
- Clearances: “Допуск 2”, “Допуск 3”.
- Priorities: “Обычный”, “Высокий”, “Аварийный”.

OUTPUT REQUIREMENTS

- Generate a full screen inventory and all screens listed above in one coherent project.
- Separate web and Android screens into clearly named sections/pages.
- Clearly label optional FSM screens as “Опциональный модуль”.
- Start by defining the shared visual system, then apply it consistently.
- Create reusable component variants and avoid duplicated one-off patterns.
- Use Auto Layout/constraints or equivalent responsive behavior.
- Make desktop tables and split map layouts practical, not decorative.
- Make mobile screens feasible for Jetpack Compose and Android navigation.
- For web export, prefer clean semantic HTML/CSS and a structure that can be converted into reusable React components.
- Avoid framework-specific backend assumptions in generated UI code.
- Do not place API keys, OTP values, access tokens, customer-sensitive data or real credentials in mockups.
- Do not invent sales/CRM features.
- The result must be detailed enough for stakeholder review and later implementation by a separate engineering team.
```

## Рекомендуемый порядок работы в Stitch

1. Сначала отправить мастер-промпт целиком и получить общую дизайн-систему и карту экранов.
2. После этого генерировать модули отдельными продолжениями: веб-планирование, веб-администрирование, Android onboarding, Android «Сегодня», опциональный FSM.
3. Согласовать desktop и mobile состояния ключевых экранов до экспорта кода.
4. Передать в Codex экспортированный код Stitch и, по возможности, ссылку на Figma.

