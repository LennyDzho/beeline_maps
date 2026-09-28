import migration0001 from "@/drizzle/0001_mushy_lizard.sql?raw";
import migration0002 from "@/drizzle/0002_left_mole_man.sql?raw";
import migration0003 from "@/drizzle/0003_silly_oracle.sql?raw";
import migration0004 from "@/drizzle/0004_legal_entities.sql?raw";
import migration0005 from "@/drizzle/0005_align_demo_planning_dates.sql?raw";
import migration0006 from "@/drizzle/0006_optimization_settings.sql?raw";
import migration0007 from "@/drizzle/0007_work_type_planned_duration.sql?raw";
import migration0008 from "@/drizzle/0008_flimsy_captain_america.sql?raw";
import migration0009 from "@/drizzle/0009_wide_morbius.sql?raw";
import migration0010 from "@/drizzle/0010_nifty_stature.sql?raw";
import migration0011 from "@/drizzle/0011_regional_scheduling.sql?raw";
import migration0014 from "@/drizzle/0014_dispatcher_notifications.sql?raw";
import migration0015 from "@/drizzle/0015_dataset_import_state.sql?raw";
import migration0016 from "@/drizzle/0016_saved_plan_results.sql?raw";
import migration0017 from "@/drizzle/0017_optimizer_service_policy.sql?raw";
import migration0018 from "@/drizzle/0018_worker_planning_availability.sql?raw";
import migration0019 from "@/drizzle/0019_worker_transport_profiles.sql?raw";
import migration0020 from "@/drizzle/0020_client_visit_confirmation.sql?raw";
import migration0021 from "@/drizzle/0021_worker_day_equipment.sql?raw";
import migration0022 from "@/drizzle/0022_common_department_plans.sql?raw";
import migration0026 from "@/drizzle/0026_category_equipment_and_employee_numbers.sql?raw";
import migration0027 from "@/drizzle/0027_global_system_settings.sql?raw";
import migration0030 from "@/drizzle/0030_supported_optimizers.sql?raw";
import migration0029 from "@/drizzle/0029_pyvrp_optimizer.sql?raw";
import migration0028 from "@/drizzle/0028_planning_timeout.sql?raw";
import migration0025 from "@/drizzle/0025_shared_work_catalog.sql?raw";
import migration0024 from "@/drizzle/0024_automatic_report_acceptance.sql?raw";
import migration0023 from "@/drizzle/0023_emergency_work_versions.sql?raw";
import migration0013 from "@/drizzle/0013_work_catalog_components.sql?raw";
import migration0012 from "@/drizzle/0012_plan_input_revisions.sql?raw";
import { initialRoles, permissionCatalog } from "@/app/admin/role-data";
import { systemUsers } from "@/app/admin/user-data";
import { initialWorkTypes, qualificationCatalog, skillCatalog, verificationMethods } from "@/app/admin/work-type-data";
import { DEFAULT_PLANNED_DURATION_MINUTES, addMinutesToTimestamp } from "@/app/lib/planned-duration";
import { vehicles } from "@/app/resources/resource-data";
import type { AuthUser } from "@/auth/session";
import { ensureAuthSchema, getBootstrapCredentials } from "@/auth/storage";

export const DEFAULT_ORGANIZATION_ID = "ORG-001";
export const LEGAL_ENTITIES = [
  { id: DEFAULT_ORGANIZATION_ID, name: 'ООО "ТехноСервис"' },
  { id: "ORG-002", name: "ИП Иванов" },
  { id: "ORG-003", name: 'АО "Городские Сети"' },
] as const;

const migrations = [
  { name: "0001_mushy_lizard", sql: migration0001 },
  { name: "0002_left_mole_man", sql: migration0002 },
  { name: "0003_silly_oracle", sql: migration0003 },
  { name: "0004_legal_entities", sql: migration0004 },
  { name: "0005_align_demo_planning_dates", sql: migration0005 },
  { name: "0006_optimization_settings", sql: migration0006 },
  { name: "0007_work_type_planned_duration", sql: migration0007 },
  { name: "0008_flimsy_captain_america", sql: migration0008 },
];

let baseInitialization: Promise<void> | null = null;

export async function ensureDomainData(user: AuthUser): Promise<D1Database> {
  const database = await ensureAuthSchema();
  baseInitialization ??= initializeDomain(database, user).catch((error) => {
    baseInitialization = null;
    throw error;
  });
  await baseInitialization;
  await ensureMembership(database, user);
  return database;
}

async function initializeDomain(database: D1Database, user: AuthUser) {
  await database.prepare(`CREATE TABLE IF NOT EXISTS domain_schema_migrations (
    name TEXT PRIMARY KEY NOT NULL,
    applied_at TEXT NOT NULL
  )`).run();

  for (const migration of migrations) {
    const applied = await database.prepare("SELECT name FROM domain_schema_migrations WHERE name = ? LIMIT 1").bind(migration.name).first();
    if (applied) continue;
    await applyMigration(database, migration.name, migration.sql);
  }

  // Existing data still requires the offline mobile upgrade. A genuinely empty
  // domain can bootstrap it atomically before any regional columns or seed rows.
  const regionalMigration = "0011_regional_scheduling";
  if (!await database.prepare("SELECT name FROM domain_schema_migrations WHERE name = ?").bind(regionalMigration).first()) {
    const schema = await database.prepare("SELECT sql FROM sqlite_master WHERE name = 'work_orders'").first<{ sql: string }>();
    if (!schema?.sql.includes("'paused'")) await initializeEmptyMobileDomain(database, user.id);
    await applyMigration(database, regionalMigration, migration0011);
  }

  if (!await database.prepare("SELECT name FROM domain_schema_migrations WHERE name = '0012_plan_input_revisions'").first()) {
    await applyMigration(database, "0012_plan_input_revisions", migration0012);
  }

  if (!await database.prepare("SELECT name FROM domain_schema_migrations WHERE name = '0013_work_catalog_components'").first()) {
    await applyMigration(database, "0013_work_catalog_components", migration0013);
  }
  if (!await database.prepare("SELECT name FROM domain_schema_migrations WHERE name = '0014_dispatcher_notifications'").first()) {
    await applyMigration(database, "0014_dispatcher_notifications", migration0014);
  }
  if (!await database.prepare("SELECT name FROM domain_schema_migrations WHERE name = '0015_dataset_import_state'").first()) {
    await applyMigration(database, "0015_dataset_import_state", migration0015);
  }
  if (!await database.prepare("SELECT name FROM domain_schema_migrations WHERE name = '0016_saved_plan_results'").first()) {
    await applyMigration(database, "0016_saved_plan_results", migration0016);
  }
  if (!await database.prepare("SELECT name FROM domain_schema_migrations WHERE name = '0017_optimizer_service_policy'").first()) {
    await applyMigration(database, "0017_optimizer_service_policy", migration0017);
  }
  if (!await database.prepare("SELECT name FROM domain_schema_migrations WHERE name = '0018_worker_planning_availability'").first()) {
    await applyMigration(database, "0018_worker_planning_availability", migration0018);
  }
  if (!await database.prepare("SELECT name FROM domain_schema_migrations WHERE name = '0019_worker_transport_profiles'").first()) {
    await applyMigration(database, "0019_worker_transport_profiles", migration0019);
  }
  if (!await database.prepare("SELECT name FROM domain_schema_migrations WHERE name = '0020_client_visit_confirmation'").first()) {
    await applyMigration(database, "0020_client_visit_confirmation", migration0020);
  }
  if (!await database.prepare("SELECT name FROM domain_schema_migrations WHERE name = '0021_worker_day_equipment'").first()) {
    await applyMigration(database, "0021_worker_day_equipment", migration0021);
  }
  if (!await database.prepare("SELECT name FROM domain_schema_migrations WHERE name = '0022_common_department_plans'").first()) {
    await applyMigration(database, "0022_common_department_plans", migration0022);
  }
  if (!await database.prepare("SELECT name FROM domain_schema_migrations WHERE name = '0023_emergency_work_versions'").first()) {
    await applyMigration(database, "0023_emergency_work_versions", migration0023);
  }
  if (!await database.prepare("SELECT name FROM domain_schema_migrations WHERE name = '0024_automatic_report_acceptance'").first()) {
    await applyMigration(database, "0024_automatic_report_acceptance", migration0024);
  }
  if (!await database.prepare("SELECT name FROM domain_schema_migrations WHERE name = '0025_shared_work_catalog'").first()) {
    await applyMigration(database, "0025_shared_work_catalog", migration0025);
  }
  if (!await database.prepare("SELECT name FROM domain_schema_migrations WHERE name = '0026_category_equipment_and_employee_numbers'").first()) {
    await applyMigration(database, "0026_category_equipment_and_employee_numbers", migration0026);
  }
  if (!await database.prepare("SELECT name FROM domain_schema_migrations WHERE name = '0027_global_system_settings'").first()) {
    await applyMigration(database, "0027_global_system_settings", migration0027);
  }
  if (!await database.prepare("SELECT name FROM domain_schema_migrations WHERE name = '0028_planning_timeout'").first()) {
    await applyMigration(database, "0028_planning_timeout", migration0028);
  }
  if (!await database.prepare("SELECT name FROM domain_schema_migrations WHERE name = '0029_pyvrp_optimizer'").first()) {
    await applyMigration(database, "0029_pyvrp_optimizer", migration0029);
  }
  if (!await database.prepare("SELECT name FROM domain_schema_migrations WHERE name = '0030_supported_optimizers'").first()) {
    await applyMigration(database, "0030_supported_optimizers", migration0030);
  }
  await seedDomain(database, user);
}

const emptyDomainSql = ["work_orders", "workers", "work_types", "service_objects", "resources"]
  .map(table => `NOT EXISTS (SELECT 1 FROM ${table})`).join(" AND ");

async function initializeEmptyMobileDomain(database: D1Database, userId: string) {
  const empty = await database.prepare(`SELECT 1 WHERE ${emptyDomainSql}`).first();
  if (!empty) throw new Error("Сначала примените миграции 0009/0010 по инструкции обновления мобильной схемы. Автоматический запуск разрешён только для пустой предметной области.");

  if (!await database.prepare("SELECT 1 FROM domain_schema_migrations WHERE name='0009_wide_morbius'").first()) {
    // Idempotent additive DDL also permits a retry after interrupted cold startup.
    const source = migration0009.replace(/CREATE TABLE /gu, "CREATE TABLE IF NOT EXISTS ")
      .replace(/CREATE INDEX /gu, "CREATE INDEX IF NOT EXISTS ").replace(/CREATE TRIGGER /gu, "CREATE TRIGGER IF NOT EXISTS ");
    await applyMigration(database, "0009_wide_morbius", source);
  }
  const now = new Date().toISOString();
  const statements = migration0010.split("--> statement-breakpoint").map(sql => sql.trim()).filter(sql => sql && !/^PRAGMA /iu.test(sql));
  // No PRAGMA foreign_keys=OFF. The guarded table is empty; DDL and its migration
  // marker must roll back together if another process populates the domain.
  await database.batch([
    database.prepare(`INSERT INTO mobile_commands(user_id,operation_id,fingerprint,accepted,created_at)
      SELECT ?,?,'empty-domain-bootstrap',CASE WHEN ${emptyDomainSql} THEN 1 ELSE 0 END,?`).bind(userId,crypto.randomUUID(),now),
    ...statements.map(sql => database.prepare(sql)),
    database.prepare("INSERT INTO domain_schema_migrations(name,applied_at) VALUES ('0010_nifty_stature',?)").bind(now),
  ]);
}

async function applyMigration(database: D1Database, name: string, source: string) {
  const statements = source
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean);

  if (name === "0025_shared_work_catalog" || name === "0026_category_equipment_and_employee_numbers" || name === "0027_global_system_settings") {
    await database.batch([...statements.map(sql => database.prepare(sql)),
      database.prepare("INSERT INTO domain_schema_migrations (name, applied_at) VALUES (?, ?)").bind(name, new Date().toISOString())]);
    return;
  }
  for (const statement of statements) {
    const additive = /^ALTER TABLE `([a-z_]+)` ADD `([a-z_]+)`/u.exec(statement);
    if (additive && await hasColumn(database, additive[1]!, additive[2]!)) continue;
    if (statement.includes("ALTER TABLE `users` ADD `must_change_password`") && await hasColumn(database, "users", "must_change_password")) continue;
    if (statement.includes("ALTER TABLE `organizations` ADD `application_name`") && await hasColumn(database, "organizations", "application_name")) continue;
    if (statement.includes("ALTER TABLE `organizations` ADD `email_alerts`") && await hasColumn(database, "organizations", "email_alerts")) continue;
    if (statement.includes("ALTER TABLE `organizations` ADD `weekly_digest`") && await hasColumn(database, "organizations", "weekly_digest")) continue;
    if (statement.includes("ALTER TABLE `organizations` ADD `optimization_engine`") && await hasColumn(database, "organizations", "optimization_engine")) continue;
    if (statement.includes("ALTER TABLE `organizations` ADD `travel_matrix_provider`") && await hasColumn(database, "organizations", "travel_matrix_provider")) continue;
    if (statement.includes("ALTER TABLE `workers` ADD `work_schedule_id`") && await hasColumn(database, "workers", "work_schedule_id")) continue;
    if (statement.includes("ALTER TABLE `workers` ADD `start_address`") && await hasColumn(database, "workers", "start_address")) continue;
    if (statement.includes("ALTER TABLE `workers` ADD `start_latitude`") && await hasColumn(database, "workers", "start_latitude")) continue;
    if (statement.includes("ALTER TABLE `workers` ADD `start_longitude`") && await hasColumn(database, "workers", "start_longitude")) continue;
    if (statement.includes("ALTER TABLE `work_type_versions` ADD `planned_duration_minutes`") && await hasColumn(database, "work_type_versions", "planned_duration_minutes")) continue;
    await database.prepare(statement).run();
  }

  await database.prepare("INSERT INTO domain_schema_migrations (name, applied_at) VALUES (?, ?)").bind(name, new Date().toISOString()).run();
}

async function hasColumn(database: D1Database, table: string, column: string) {
  const result = await database.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
  return result.results.some((item) => item.name === column);
}

async function seedDomain(database: D1Database, currentUser: AuthUser) {
  // The imported namespace is authoritative; never resurrect old demo rows.
  if (await database.prepare("SELECT version FROM application_dataset WHERE id=1").first()) return;
  const now = new Date().toISOString();
  const statements: D1PreparedStatement[] = [];
  const add = (sql: string, ...values: unknown[]) => statements.push(database.prepare(sql).bind(...values));

  for (const organization of LEGAL_ENTITIES) {
    add(`INSERT OR IGNORE INTO organizations
      (id, name, timezone, application_name, email_alerts, weekly_digest, status, created_at, updated_at)
      VALUES (?, ?, 'Europe/Moscow', 'Марш!', 1, 0, 'active', ?, ?)`, organization.id, organization.name, now, now);
  }

  for (const permission of permissionCatalog) {
    add("INSERT OR IGNORE INTO permissions (code, name, description) VALUES (?, ?, ?)", permission.id, permission.label, permission.description);
  }
  for (const organization of LEGAL_ENTITIES) {
    for (const role of initialRoles) {
      const roleId = organizationRoleId(organization.id, role.id);
      add(`INSERT OR IGNORE INTO roles (id, organization_id, code, name, description, is_system, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 1, ?, ?)`, roleId, organization.id, role.id, role.name, role.description, now, now);
      for (const permissionId of role.permissions) {
        add("INSERT OR IGNORE INTO role_permissions (role_id, permission_code) VALUES (?, ?)", roleId, permissionId);
      }
    }
  }

  const unusableSalt = "AAAAAAAAAAAAAAAAAAAAAA==";
  const unusableHash = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
  for (const user of systemUsers) {
    add(`INSERT OR IGNORE INTO users
      (id, email, display_name, role, password_salt, password_hash, password_iterations, must_change_password, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 210000, 1, ?, ?, ?)`, user.id, user.email, user.name, user.roleId ?? "dispatcher", unusableSalt, unusableHash, user.status === "blocked" ? "blocked" : "active", now, now);
    if (user.roleId) {
      add(`INSERT OR IGNORE INTO memberships (id, organization_id, user_id, role_id, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'active', ?, ?)`, `MEM-${user.id}`, DEFAULT_ORGANIZATION_ID, user.id, user.roleId, now, now);
    }
  }

  const areaNames = ["Север", "Юг", "Центр", "Запад", "Восток"];
  areaNames.forEach((name, index) => add("INSERT OR IGNORE INTO service_areas (id, organization_id, code, name, active) VALUES (?, ?, ?, ?, 1)", `AREA-${index + 1}`, DEFAULT_ORGANIZATION_ID, `area-${index + 1}`, name));
  skillCatalog.forEach((name, index) => add("INSERT OR IGNORE INTO skills (id, organization_id, name, description, active) VALUES (?, ?, ?, '', 1)", `SKILL-${index + 1}`, DEFAULT_ORGANIZATION_ID, name));
  qualificationCatalog.forEach((name, index) => add("INSERT OR IGNORE INTO qualifications (id, organization_id, code, name, description, validity_required, active) VALUES (?, ?, ?, ?, '', 0, 1)", `QUAL-${index + 1}`, DEFAULT_ORGANIZATION_ID, `qualification-${index + 1}`, name));

  add(`INSERT OR IGNORE INTO work_schedules (id, organization_id, name, active, created_at, updated_at)
    VALUES ('SCHEDULE-STANDARD', ?, 'Стандартный 5/2', 1, ?, ?)`, DEFAULT_ORGANIZATION_ID, now, now);
  for (let weekday = 1; weekday <= 7; weekday += 1) {
    const enabled = weekday <= 5;
    add(`INSERT OR IGNORE INTO work_schedule_days (schedule_id, weekday, enabled, start_time, end_time, break_start, break_end)
      VALUES ('SCHEDULE-STANDARD', ?, ?, ?, ?, ?, ?)`, weekday, enabled ? 1 : 0, enabled ? "08:00" : null, enabled ? "17:00" : null, enabled ? "12:00" : null, enabled ? "13:00" : null);
  }

  for (const method of verificationMethods.filter((item) => item.kind === "ai")) {
    add(`INSERT OR IGNORE INTO ai_verifier_connections
      (id, organization_id, name, provider, model_name, endpoint_url, secret_reference, status, timeout_seconds, max_attempts, created_at, updated_at)
      VALUES (?, ?, ?, 'configured', ?, 'https://example.invalid/verify', 'AI_VERIFIER_KEY', 'active', 30, 2, ?, ?)`, method.id, DEFAULT_ORGANIZATION_ID, method.label, method.label, now, now);
  }

  for (const workType of initialWorkTypes) {
    const versionId = `${workType.id}-V1`;
    add(`INSERT OR IGNORE INTO work_types (id, organization_id, code, name, description, active, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 1, ?, ?)`, workType.id, DEFAULT_ORGANIZATION_ID, workType.id, workType.name, workType.description, now, now);
    add(`INSERT OR IGNORE INTO work_type_versions
      (id, work_type_id, version, status, planned_duration_minutes, verification_mode, ai_verifier_connection_id, report_template_json, evidence_policy_json, published_by_user_id, published_at, created_at)
      VALUES (?, ?, 1, 'published', ?, ?, ?, '{}', '{}', ?, ?, ?)`, versionId, workType.id, workType.plannedDurationMinutes, workType.verificationMethodId === "dispatcher" ? "dispatcher" : "ai_model", workType.verificationMethodId === "dispatcher" ? null : workType.verificationMethodId, currentUser.id, now, now);
    workType.requiredSkills.forEach((skill) => {
      const skillId = `SKILL-${skillCatalog.indexOf(skill) + 1}`;
      add("INSERT OR IGNORE INTO work_type_version_skills (work_type_version_id, skill_id) VALUES (?, ?)", versionId, skillId);
    });
    workType.requiredQualifications.forEach((qualification) => {
      const qualificationId = `QUAL-${qualificationCatalog.indexOf(qualification) + 1}`;
      add("INSERT OR IGNORE INTO work_type_version_qualifications (work_type_version_id, qualification_id) VALUES (?, ?)", versionId, qualificationId);
    });
  }

  const workers = [
    { id: "EMP-402", userId: "USR-402", name: "Алексей Иванов", phone: "+7 916 123-45-67", status: "on_shift", load: 75, area: "AREA-1", skills: ["Электрика", "Диагностика"], qualifications: ["Допуск 2", "Допуск 3"], transportMode: "car", transport: "А777АА", warning: 0, startAddress: "Москва, Тверская улица, 18", lat: 55.764332, lon: 37.605765 },
    { id: "EMP-415", userId: "USR-415", name: "Марина Соколова", phone: "+7 903 765-43-21", status: "break", load: 40, area: "AREA-1", skills: ["Клининг", "Сети", "Диагностика", "Монтаж", "Электрика"], qualifications: ["Мастер", "Допуск 2", "Допуск 3", "Работы на высоте"], transportMode: "transit", transport: "Метро", warning: 0, startAddress: "Москва, Ленинградский проспект, 15", lat: 55.78646, lon: 37.57079 },
    { id: "EMP-390", userId: "USR-390", name: "Илья Козлов", phone: "+7 925 555-19-90", status: "off_shift", load: 0, area: "AREA-2", skills: ["Сварка"], qualifications: ["Допуск 2"], transportMode: "none", transport: "Нет", warning: 1, startAddress: "Москва, улица Арбат, 12", lat: 55.75232, lon: 37.59312 },
  ];
  const existingWorkers = await database.prepare(`SELECT id FROM workers WHERE id IN (${workers.map(() => "?").join(",")})`)
    .bind(...workers.map((worker) => worker.id)).all<{ id: string }>();
  const existingWorkerIds = new Set(existingWorkers.results.map((worker) => worker.id));
  for (const worker of workers) {
    add(`INSERT OR IGNORE INTO workers
      (id, organization_id, user_id, service_area_id, work_schedule_id, employee_number, full_name, phone, start_address, start_latitude, start_longitude, shift_status, load_percent, transport_mode, transport_details, qualification_warning, active, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'SCHEDULE-STANDARD', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`, worker.id, DEFAULT_ORGANIZATION_ID, worker.userId, worker.area, worker.id, worker.name, worker.phone, worker.startAddress, worker.lat, worker.lon, worker.status, worker.load, worker.transportMode, worker.transport, worker.warning, now, now);
    // Seed assignments only for new demo workers; never restore skills or
    // qualifications explicitly removed from an existing worker in the UI.
    if (!existingWorkerIds.has(worker.id)) {
      worker.skills.forEach((skill) => add("INSERT OR IGNORE INTO worker_skills (worker_id, skill_id, level, confirmed_at) VALUES (?, ?, 'qualified', ?)", worker.id, `SKILL-${skillCatalog.indexOf(skill) + 1}`, now));
      worker.qualifications.forEach((qualification) => add("INSERT OR IGNORE INTO worker_qualifications (worker_id, qualification_id, status) VALUES (?, ?, ?)", worker.id, `QUAL-${qualificationCatalog.indexOf(qualification) + 1}`, worker.warning ? "expiring" : "valid"));
    }
  }

  for (const vehicle of vehicles) {
    const areaId = vehicle.section ? `AREA-${areaNames.indexOf(vehicle.section) + 1}` : null;
    const assignedWorker = workers.find((worker) => worker.name === vehicle.assignment);
    add(`INSERT OR IGNORE INTO resources
      (id, organization_id, service_area_id, assigned_worker_id, name, type, plate, region, vin, status, condition, next_service_at, notes, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, vehicle.id, DEFAULT_ORGANIZATION_ID, areaId, assignedWorker?.id ?? null, vehicle.name, vehicle.type, vehicle.plate, vehicle.region, vehicle.vin ?? null, vehicle.status, vehicle.condition === "Исправен" ? "serviceable" : "service_required", vehicle.serviceDate ?? null, vehicle.notes ?? "", now, now);
  }

  const orders = [
    { id: "A-1428", type: "WORK-001", description: "Диагностика и ремонт оборудования на объекте.", priority: "high", status: "assigned", start: "2026-08-20T09:00", address: "Москва, Ленинградский проспект, 15", lat: 55.78646, lon: 37.57079, assignee: "EMP-402" },
    { id: "A-1431", type: "WORK-002", description: "Плановое техническое обслуживание оборудования.", priority: "medium", status: "assigned", start: "2026-08-20T11:30", address: "Москва, Новослободская улица, 24", lat: 55.7803, lon: 37.5978, assignee: "EMP-402" },
    { id: "B-092", type: "WORK-003", description: "Проверка сетевого подключения на объекте.", priority: "low", status: "assigned", start: "2026-08-20T10:15", address: "Москва, улица Арбат, 12", lat: 55.75232, lon: 37.59312, assignee: "EMP-415" },
    { id: "B-104", type: "WORK-004", description: "Монтаж и первичная настройка оборудования.", priority: "medium", status: "assigned", start: "2026-08-20T13:00", address: "Москва, Пречистенская набережная, 9", lat: 55.7407, lon: 37.5984, assignee: "EMP-415" },
    { id: "ORD-9021", type: "WORK-001", description: "Диагностика и восстановление работы оборудования.", priority: "high", status: "new", start: "2026-08-24T09:00", address: "Москва, Тверская улица, 18", lat: 55.76433, lon: 37.60576, assignee: null },
    { id: "ORD-9020", type: "WORK-002", description: "Провести плановое техническое обслуживание.", priority: "medium", status: "in_progress", start: "2026-08-24T08:30", address: "Москва, Ленинградский проспект, 24", lat: 55.7877, lon: 37.5667, assignee: "EMP-402" },
    { id: "ORD-9019", type: "WORK-003", description: "Проверить стабильность подключения и сетевое оборудование.", priority: "low", status: "assigned", start: "2026-08-23T16:45", address: "Москва, Большая Дмитровка, 7", lat: 55.7606, lon: 37.614, assignee: "EMP-415" },
    { id: "ORD-9018", type: "WORK-004", description: "Установить и проверить новый комплект оборудования.", priority: "medium", status: "completed", start: "2026-08-23T14:20", address: "Москва, Кутузовский проспект, 31", lat: 55.7418, lon: 37.5317, assignee: "EMP-390" },
  ];
  for (const order of orders) {
    const plannedDurationMinutes = initialWorkTypes.find((workType) => workType.id === order.type)?.plannedDurationMinutes ?? DEFAULT_PLANNED_DURATION_MINUTES;
    const scheduledEnd = addMinutesToTimestamp(order.start, plannedDurationMinutes);
    add(`INSERT OR IGNORE INTO service_objects
      (id, organization_id, external_reference, name, address, latitude, longitude, notes, active, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, '', 1, ?, ?)`, `OBJECT-${order.id}`, DEFAULT_ORGANIZATION_ID, order.id, `Объект ${order.id}`, order.address, order.lat, order.lon, now, now);
    add(`INSERT OR IGNORE INTO work_orders
      (id, organization_id, number, work_type_version_id, service_object_id, assignee_worker_id, created_by_user_id, description, priority, status, scheduled_start, scheduled_end, address_snapshot, latitude_snapshot, longitude_snapshot, completed_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, order.id, DEFAULT_ORGANIZATION_ID, order.id, `${order.type}-V1`, `OBJECT-${order.id}`, order.assignee, currentUser.id, order.description, order.priority, order.status, order.start, scheduledEnd, order.address, order.lat, order.lon, order.status === "completed" ? "2026-08-23T17:38:00.000Z" : null, now, now);
    // Startup may create missing demo records, never overwrite existing orders or
    // increment their revisions. Backfills belong in explicit one-time migrations.
  }

  add(`INSERT OR IGNORE INTO work_reports
    (id, work_order_id, performer_worker_id, revision, status, comment, field_values_json, submitted_at, created_at, updated_at)
    VALUES ('REPORT-ORD-9018', 'ORD-9018', 'EMP-390', 1, 'submitted', ?, '{}', '2026-08-23T17:38:00.000Z', ?, ?)`, "Оборудование установлено, подключено и проверено под рабочей нагрузкой. Замечаний нет, рабочее место убрано.", now, now);
  const media = [
    ["photo-1", "photo", "оборудование_после.jpg", 2_400_000],
    ["photo-2", "photo", "подключение.jpg", 1_800_000],
    ["video-1", "video", "проверка_работы.mp4", 8_700_000],
  ];
  for (const [id, kind, fileName, sizeBytes] of media) {
    add(`INSERT OR IGNORE INTO report_media
      (id, report_id, kind, category, storage_key, file_name, mime_type, size_bytes, checksum, upload_status, created_at)
      VALUES (?, 'REPORT-ORD-9018', ?, 'result', ?, ?, ?, ?, ?, 'uploaded', ?)`, id, kind, `demo/${id}`, fileName, kind === "photo" ? "image/jpeg" : "video/mp4", sizeBytes, `demo-${id}`, now);
  }

  for (let index = 0; index < statements.length; index += 75) {
    await database.batch(statements.slice(index, index + 75));
  }
}

async function ensureMembership(database: D1Database, user: AuthUser) {
  if (await database.prepare("SELECT version FROM application_dataset WHERE id=1").first()) return;
  const now = new Date().toISOString();
  const roleCode = user.role === "admin" || user.role === "administrator"
    ? "administrator"
    : user.role === "executor"
      ? "executor"
      : "dispatcher";
  const bootstrap = getBootstrapCredentials();
  const isBootstrapAdministrator = bootstrap?.email === user.email;
  const existing = await database.prepare("SELECT 1 AS present FROM memberships WHERE user_id = ? LIMIT 1").bind(user.id).first();
  const organizations = isBootstrapAdministrator ? LEGAL_ENTITIES : existing ? [] : [LEGAL_ENTITIES[0]];
  for (const organization of organizations) {
    await database.prepare(`INSERT INTO memberships (id, organization_id, user_id, role_id, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'active', ?, ?)
      ON CONFLICT(organization_id, user_id) DO NOTHING`).bind(
        `MEM-${organization.id}-${user.id}`, organization.id, user.id, organizationRoleId(organization.id, roleCode), now, now,
      ).run();
  }
}

function organizationRoleId(organizationId: string, roleCode: string) {
  return organizationId === DEFAULT_ORGANIZATION_ID ? roleCode : `${organizationId}:${roleCode}`;
}
