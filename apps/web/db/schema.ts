import { sql } from "drizzle-orm";
import { check, index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

// Authentication. Kept compatible with auth/storage.ts while authorization is normalized below.
export const users = sqliteTable("users", {
  id: text("id").primaryKey(), email: text("email").notNull(), displayName: text("display_name").notNull(),
  role: text("role").notNull().default("dispatcher"), passwordSalt: text("password_salt").notNull(),
  passwordHash: text("password_hash").notNull(), passwordIterations: integer("password_iterations").notNull(),
  mustChangePassword: integer("must_change_password", { mode: "boolean" }).notNull().default(false),
  status: text("status").notNull().default("active"), createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull(),
}, (table) => [uniqueIndex("users_email_unique").on(table.email)]);

export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(), userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull(), expiresAt: text("expires_at").notNull(), createdAt: text("created_at").notNull(),
}, (table) => [uniqueIndex("sessions_token_hash_unique").on(table.tokenHash), index("sessions_user_id_idx").on(table.userId), index("sessions_expires_at_idx").on(table.expiresAt)]);

export const authLoginAttempts = sqliteTable("auth_login_attempts", {
  email: text("email").primaryKey(), failedAttempts: integer("failed_attempts").notNull().default(0),
  lockedUntil: text("locked_until"), updatedAt: text("updated_at").notNull(),
}, (table) => [index("auth_login_attempts_updated_at_idx").on(table.updatedAt)]);

// Organization and RBAC.
export const organizations = sqliteTable("organizations", {
  id: text("id").primaryKey(), name: text("name").notNull(), timezone: text("timezone").notNull().default("Europe/Moscow"),
  applicationName: text("application_name").notNull().default("Маршрут FSM"),
  officeAddress: text("office_address").notNull().default(""), officeLatitude: real("office_latitude"), officeLongitude: real("office_longitude"),
  emailAlerts: integer("email_alerts", { mode: "boolean" }).notNull().default(true),
  weeklyDigest: integer("weekly_digest", { mode: "boolean" }).notNull().default(false),
  optimizationEngine: text("optimization_engine").notNull().default("local_greedy"),
  travelMatrixProvider: text("travel_matrix_provider").notNull().default("two_gis"),
  status: text("status").notNull().default("active"), createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull(),
}, (table) => [
  check("organizations_status_check", sql`${table.status} in ('active', 'suspended')`),
  check("organizations_optimization_engine_check", sql`${table.optimizationEngine} in ('local_greedy')`),
  check("organizations_travel_matrix_provider_check", sql`${table.travelMatrixProvider} in ('two_gis', 'local_estimated')`),
]);

export const systemSettings = sqliteTable("system_settings", {
  calculationTimeoutSeconds: integer("calculation_timeout_seconds").notNull().default(180),
  id: integer("id").primaryKey(),
  applicationName: text("application_name").notNull().default("Марш!"),
  emailAlerts: integer("email_alerts", { mode: "boolean" }).notNull().default(true),
  weeklyDigest: integer("weekly_digest", { mode: "boolean" }).notNull().default(false),
  optimizationEngine: text("optimization_engine").notNull().default("pyvrp"),
  travelMatrixProvider: text("travel_matrix_provider").notNull().default("osrm"),
  solverPolicy: text("solver_policy").notNull().default("emergency_fast/v1"),
  updatedAt: text("updated_at").notNull(),
}, table=>[
  check("system_settings_singleton",sql`${table.id}=1`),
  check("system_settings_timeout",sql`${table.calculationTimeoutSeconds} BETWEEN 30 AND 1800`),
  check("system_settings_engine",sql`${table.optimizationEngine} IN ('ortools','pyvrp','two_gis_tsp')`),
  check("system_settings_matrix",sql`${table.travelMatrixProvider} IN ('osrm','two_gis')`),
  check("system_settings_policy",sql`${table.solverPolicy} IN ('emergency_fast/v1','emergency_staff/v1')`),
  check("system_settings_combination",sql`${table.optimizationEngine}<>'two_gis_tsp' OR ${table.travelMatrixProvider}='two_gis'`),
]);

// Historical department choices remain available for upgrades; runtime reads system_settings.
export const organizationPlanningSettings = sqliteTable("organization_planning_settings", {
  organizationId: text("organization_id").primaryKey().references(() => organizations.id, { onDelete: "cascade" }),
  optimizationEngine: text("optimization_engine").notNull().default("local_greedy"),
  travelMatrixProvider: text("travel_matrix_provider").notNull().default("two_gis"),
  solverEngine: text("solver_engine"),
  solverPolicy: text("solver_policy").notNull().default("emergency_fast/v1"),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  check("planner_engine_check", sql`${table.optimizationEngine} in ('local_greedy', 'two_gis_tsp')`),
  check("planner_matrix_check", sql`${table.travelMatrixProvider} in ('two_gis', 'osrm')`),
  check("planner_combination_check", sql`${table.optimizationEngine} != 'two_gis_tsp' or ${table.travelMatrixProvider} = 'two_gis'`),
]);

export const roles = sqliteTable("roles", {
  id: text("id").primaryKey(), organizationId: text("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  code: text("code").notNull(), name: text("name").notNull(), description: text("description").notNull().default(""),
  isSystem: integer("is_system", { mode: "boolean" }).notNull().default(false), createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull(),
}, (table) => [uniqueIndex("roles_organization_code_unique").on(table.organizationId, table.code), index("roles_organization_id_idx").on(table.organizationId)]);

export const permissions = sqliteTable("permissions", {
  code: text("code").primaryKey(), name: text("name").notNull(), description: text("description").notNull().default(""),
});

export const rolePermissions = sqliteTable("role_permissions", {
  roleId: text("role_id").notNull().references(() => roles.id, { onDelete: "cascade" }),
  permissionCode: text("permission_code").notNull().references(() => permissions.code, { onDelete: "cascade" }),
}, (table) => [primaryKey({ columns: [table.roleId, table.permissionCode] })]);

export const memberships = sqliteTable("memberships", {
  id: text("id").primaryKey(), organizationId: text("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  roleId: text("role_id").notNull().references(() => roles.id, { onDelete: "restrict" }), status: text("status").notNull().default("active"),
  createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull(),
}, (table) => [uniqueIndex("memberships_organization_user_unique").on(table.organizationId, table.userId), index("memberships_role_id_idx").on(table.roleId), check("memberships_status_check", sql`${table.status} in ('invited', 'active', 'blocked', 'revoked')`)]);

// Personnel, service areas, skills and qualifications.
export const serviceAreas = sqliteTable("service_areas", {
  id: text("id").primaryKey(), organizationId: text("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  code: text("code").notNull(), name: text("name").notNull(), active: integer("active", { mode: "boolean" }).notNull().default(true),
}, (table) => [uniqueIndex("service_areas_organization_code_unique").on(table.organizationId, table.code)]);

export const workSchedules = sqliteTable("work_schedules", {
  id: text("id").primaryKey(), organizationId: text("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  name: text("name").notNull(), active: integer("active", { mode: "boolean" }).notNull().default(true),
  createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull(),
}, (table) => [uniqueIndex("work_schedules_organization_name_unique").on(table.organizationId, table.name), index("work_schedules_organization_active_idx").on(table.organizationId, table.active)]);

export const workScheduleDays = sqliteTable("work_schedule_days", {
  scheduleId: text("schedule_id").notNull().references(() => workSchedules.id, { onDelete: "cascade" }),
  weekday: integer("weekday").notNull(), enabled: integer("enabled", { mode: "boolean" }).notNull().default(false),
  startTime: text("start_time"), endTime: text("end_time"), breakStart: text("break_start"), breakEnd: text("break_end"),
}, (table) => [
  primaryKey({ columns: [table.scheduleId, table.weekday] }),
  check("work_schedule_days_weekday_check", sql`${table.weekday} between 1 and 7`),
  check("work_schedule_days_work_time_check", sql`(${table.enabled} = 0) or (${table.startTime} is not null and ${table.endTime} is not null and ${table.startTime} < ${table.endTime})`),
  check("work_schedule_days_break_check", sql`(${table.breakStart} is null and ${table.breakEnd} is null) or (${table.breakStart} is not null and ${table.breakEnd} is not null and ${table.breakStart} < ${table.breakEnd})`),
]);

export const workers = sqliteTable("workers", {
  id: text("id").primaryKey(), organizationId: text("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  userId: text("user_id").references(() => users.id, { onDelete: "set null" }), serviceAreaId: text("service_area_id").references(() => serviceAreas.id, { onDelete: "set null" }),
  workScheduleId: text("work_schedule_id").references(() => workSchedules.id, { onDelete: "set null" }),
  employeeNumber: text("employee_number").notNull(), fullName: text("full_name").notNull(), phone: text("phone").notNull(),
  timezone: text("timezone"),
  startAddress: text("start_address").notNull().default(""), startLatitude: real("start_latitude"), startLongitude: real("start_longitude"),
  shiftStatus: text("shift_status").notNull().default("off_shift"), loadPercent: integer("load_percent").notNull().default(0),
  transportMode: text("transport_mode").notNull().default("none"), transportDetails: text("transport_details").notNull().default(""),
  // Canonical profile; the legacy column remains readable by older clients.
  travelMode: text("travel_mode", { enum: ["car", "walking", "cycling", "transit"] }),
  qualificationWarning: integer("qualification_warning", { mode: "boolean" }).notNull().default(false),
  active: integer("active", { mode: "boolean" }).notNull().default(true), createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull(),
}, (table) => [uniqueIndex("workers_organization_employee_unique").on(table.organizationId, table.employeeNumber), uniqueIndex("workers_user_id_unique").on(table.userId), index("workers_service_area_id_idx").on(table.serviceAreaId), index("workers_work_schedule_id_idx").on(table.workScheduleId), check("workers_shift_status_check", sql`${table.shiftStatus} in ('on_shift', 'break', 'off_shift')`), check("workers_load_percent_check", sql`${table.loadPercent} between 0 and 100`), check("workers_transport_mode_check", sql`${table.transportMode} in ('car', 'transit', 'none')`), check("workers_start_latitude_check", sql`${table.startLatitude} is null or ${table.startLatitude} between -90 and 90`), check("workers_start_longitude_check", sql`${table.startLongitude} is null or ${table.startLongitude} between -180 and 180`), check("workers_start_point_check", sql`(${table.startLatitude} is null) = (${table.startLongitude} is null)`)]);

export const skills = sqliteTable("skills", {
  id: text("id").primaryKey(), organizationId: text("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  name: text("name").notNull(), description: text("description").notNull().default(""), active: integer("active", { mode: "boolean" }).notNull().default(true),
}, (table) => [uniqueIndex("skills_shared_name_unique").on(table.name), uniqueIndex("skills_organization_name_unique").on(table.organizationId, table.name)]);

export const qualifications = sqliteTable("qualifications", {
  id: text("id").primaryKey(), organizationId: text("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  code: text("code").notNull(), name: text("name").notNull(), description: text("description").notNull().default(""),
  validityRequired: integer("validity_required", { mode: "boolean" }).notNull().default(false), active: integer("active", { mode: "boolean" }).notNull().default(true),
}, (table) => [uniqueIndex("qualifications_shared_name_unique").on(table.name), uniqueIndex("qualifications_organization_code_unique").on(table.organizationId, table.code)]);

export const workerPlanningAvailability = sqliteTable("worker_planning_availability", {
  workerId: text("worker_id").primaryKey().references(() => workers.id, { onDelete: "cascade" }),
  availableAt: text("available_at").notNull(), address: text("address").notNull(),
  latitude: real("latitude").notNull(), longitude: real("longitude").notNull(),
  activityRevision: text("activity_revision").notNull(), updatedByUserId: text("updated_by_user_id").references(() => users.id, { onDelete: "set null" }),
  updatedAt: text("updated_at").notNull(),
}, table => [check("worker_availability_latitude_check", sql`${table.latitude} between -90 and 90`), check("worker_availability_longitude_check", sql`${table.longitude} between -180 and 180`)]);

export const workerSkills = sqliteTable("worker_skills", {
  workerId: text("worker_id").notNull().references(() => workers.id, { onDelete: "cascade" }),
  skillId: text("skill_id").notNull().references(() => skills.id, { onDelete: "restrict" }),
  level: text("level").notNull().default("qualified"), confirmedAt: text("confirmed_at"),
}, (table) => [primaryKey({ columns: [table.workerId, table.skillId] })]);

export const workerQualifications = sqliteTable("worker_qualifications", {
  workerId: text("worker_id").notNull().references(() => workers.id, { onDelete: "cascade" }),
  qualificationId: text("qualification_id").notNull().references(() => qualifications.id, { onDelete: "restrict" }),
  documentNumber: text("document_number"), issuedAt: text("issued_at"), expiresAt: text("expires_at"), status: text("status").notNull().default("valid"),
}, (table) => [primaryKey({ columns: [table.workerId, table.qualificationId] }), index("worker_qualifications_expires_at_idx").on(table.expiresAt), check("worker_qualifications_status_check", sql`${table.status} in ('valid', 'expiring', 'expired', 'suspended')`)]);

// Resources.
export const resources = sqliteTable("resources", {
  id: text("id").primaryKey(), organizationId: text("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  serviceAreaId: text("service_area_id").references(() => serviceAreas.id, { onDelete: "set null" }), assignedWorkerId: text("assigned_worker_id").references(() => workers.id, { onDelete: "set null" }),
  name: text("name").notNull(), type: text("type").notNull(), plate: text("plate"), region: text("region"), vin: text("vin"),
  status: text("status").notNull().default("available"), condition: text("condition").notNull().default("serviceable"), nextServiceAt: text("next_service_at"),
  notes: text("notes").notNull().default(""), createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull(),
}, (table) => [uniqueIndex("resources_organization_vin_unique").on(table.organizationId, table.vin), index("resources_organization_status_idx").on(table.organizationId, table.status), index("resources_assigned_worker_id_idx").on(table.assignedWorkerId), check("resources_status_check", sql`${table.status} in ('working', 'repair', 'available', 'inactive')`), check("resources_condition_check", sql`${table.condition} in ('serviceable', 'service_required', 'unserviceable')`)]);

// Work-type configuration and immutable published versions.
export const aiVerifierConnections = sqliteTable("ai_verifier_connections", {
  id: text("id").primaryKey(), organizationId: text("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  name: text("name").notNull(), provider: text("provider").notNull(), modelName: text("model_name").notNull(), endpointUrl: text("endpoint_url").notNull(),
  secretReference: text("secret_reference").notNull(), status: text("status").notNull().default("active"), timeoutSeconds: integer("timeout_seconds").notNull().default(30),
  maxAttempts: integer("max_attempts").notNull().default(2), createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull(),
}, (table) => [uniqueIndex("ai_verifier_connections_organization_name_unique").on(table.organizationId, table.name), check("ai_verifier_connections_status_check", sql`${table.status} in ('active', 'disabled')`), check("ai_verifier_connections_timeout_check", sql`${table.timeoutSeconds} between 1 and 300`), check("ai_verifier_connections_attempts_check", sql`${table.maxAttempts} between 1 and 10`)]);

export const workTypes = sqliteTable("work_types", {
  id: text("id").primaryKey(), organizationId: text("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  code: text("code").notNull(), name: text("name").notNull(), description: text("description").notNull().default(""),
  active: integer("active", { mode: "boolean" }).notNull().default(true), createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull(),
}, (table) => [uniqueIndex("work_types_shared_name_unique").on(table.name), uniqueIndex("work_types_organization_code_unique").on(table.organizationId, table.code)]);

export const workCategories = sqliteTable("work_categories", {
  equipmentConfigured: integer("equipment_configured", { mode: "boolean" }).notNull().default(false),
  id: text("id").primaryKey(), organizationId: text("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  name: text("name").notNull(), description: text("description").notNull().default(""),
  serviceDurationMinutes: integer("service_duration_minutes"), durationSource: text("duration_source").notNull().default(""),
  active: integer("active", { mode: "boolean" }).notNull().default(true), createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull(),
}, table => [uniqueIndex("work_categories_shared_name_unique").on(table.name)]);

// An immutable source manifest and active namespace for the final dataset transition.
export const datasetImports = sqliteTable("dataset_imports", {
  version: text("version").primaryKey(), contentHash: text("content_hash").notNull(), manifestJson: text("manifest_json").notNull(),
  importedByUserId: text("imported_by_user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  importedAt: text("imported_at").notNull(), emptyTargetGuard: integer("empty_target_guard").notNull(),
}, table => [check("dataset_import_empty_target", sql`${table.emptyTargetGuard} = 1`)]);

export const applicationDataset = sqliteTable("application_dataset", {
  id: integer("id").primaryKey(), version: text("version").notNull().references(() => datasetImports.version, { onDelete: "restrict" }),
  updatedAt: text("updated_at").notNull(),
}, table => [check("application_dataset_singleton", sql`${table.id} = 1`)]);

export const categoryWorkTypes = sqliteTable("category_work_types", {
  categoryId: text("category_id").notNull().references(() => workCategories.id, { onDelete: "cascade" }),
  workTypeId: text("work_type_id").notNull().references(() => workTypes.id, { onDelete: "cascade" }),
}, table => [primaryKey({ columns: [table.categoryId, table.workTypeId] })]);

export const workTypeAliases = sqliteTable("work_type_aliases", {
  organizationId: text("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  alias: text("alias").notNull(), workTypeId: text("work_type_id").notNull().references(() => workTypes.id, { onDelete: "cascade" }),
}, table => [uniqueIndex("work_type_aliases_shared_alias_unique").on(table.alias), primaryKey({ columns: [table.organizationId, table.alias] })]);

export const workerWorkCompetencies = sqliteTable("worker_work_competencies", {
  workerId: text("worker_id").notNull().references(() => workers.id, { onDelete: "cascade" }),
  categoryId: text("category_id").notNull().references(() => workCategories.id, { onDelete: "restrict" }),
  workTypeId: text("work_type_id").notNull().references(() => workTypes.id, { onDelete: "restrict" }),
}, table => [primaryKey({ columns: [table.workerId, table.categoryId, table.workTypeId] })]);

export const equipmentItems = sqliteTable("equipment_items", {
  id: text("id").primaryKey(), organizationId: text("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  name: text("name").notNull(), unit: text("unit").notNull().default(""), usage: text("usage").notNull().default("unspecified"),
  active: integer("active", { mode: "boolean" }).notNull().default(true), createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull(),
}, table => [uniqueIndex("equipment_items_shared_name_unique").on(table.name), check("equipment_usage_check", sql`${table.usage} in ('unspecified', 'consumable', 'reusable')`)]);

export const categoryEquipment = sqliteTable("category_equipment", {
  categoryId: text("category_id").notNull().references(() => workCategories.id, { onDelete: "cascade" }),
  equipmentId: text("equipment_id").notNull().references(() => equipmentItems.id, { onDelete: "restrict" }),
  quantity: real("quantity"),
}, table => [primaryKey({ columns: [table.categoryId, table.equipmentId] }), check("category_equipment_quantity", sql.raw("quantity IS NULL OR (quantity>0 AND quantity<=1000000)"))]);
export const resourceAssignmentGuards = sqliteTable("resource_assignment_guards", {
  id: text("id").primaryKey(), available: integer("available").notNull(),
}, () => [check("resource_must_be_available", sql.raw("available=1"))]);

export const workTypeVersions = sqliteTable("work_type_versions", {
  autoAcceptReport: integer("auto_accept_report", { mode: "boolean" }).notNull().default(false),
  isEmergency: integer("is_emergency", { mode: "boolean" }).notNull().default(false),
  id: text("id").primaryKey(), workTypeId: text("work_type_id").notNull().references(() => workTypes.id, { onDelete: "cascade" }),
  version: integer("version").notNull(), status: text("status").notNull().default("draft"),
  plannedDurationMinutes: integer("planned_duration_minutes").notNull().default(60), verificationMode: text("verification_mode").notNull().default("dispatcher"),
  aiVerifierConnectionId: text("ai_verifier_connection_id").references(() => aiVerifierConnections.id, { onDelete: "restrict" }),
  reportTemplateJson: text("report_template_json").notNull().default("{}"), evidencePolicyJson: text("evidence_policy_json").notNull().default("{}"),
  publishedByUserId: text("published_by_user_id").references(() => users.id, { onDelete: "set null" }), publishedAt: text("published_at"), createdAt: text("created_at").notNull(),
}, (table) => [check("work_type_versions_auto_accept_check", sql`${table.autoAcceptReport} in (0, 1) and (${table.autoAcceptReport} = 0 or (${table.verificationMode} = 'dispatcher' and ${table.aiVerifierConnectionId} is null))`), uniqueIndex("work_type_versions_work_type_version_unique").on(table.workTypeId, table.version), index("work_type_versions_status_idx").on(table.status), check("work_type_versions_version_check", sql`${table.version} > 0`), check("work_type_versions_status_check", sql`${table.status} in ('draft', 'published', 'archived')`), check("work_type_versions_planned_duration_check", sql`${table.plannedDurationMinutes} between 15 and 480`), check("work_type_versions_verification_mode_check", sql`${table.verificationMode} in ('dispatcher', 'ai_model')`), check("work_type_versions_verifier_check", sql`(${table.verificationMode} = 'dispatcher' and ${table.aiVerifierConnectionId} is null) or (${table.verificationMode} = 'ai_model' and ${table.aiVerifierConnectionId} is not null)`)]);

export const workTypeVersionSkills = sqliteTable("work_type_version_skills", {
  workTypeVersionId: text("work_type_version_id").notNull().references(() => workTypeVersions.id, { onDelete: "cascade" }),
  skillId: text("skill_id").notNull().references(() => skills.id, { onDelete: "restrict" }),
}, (table) => [primaryKey({ columns: [table.workTypeVersionId, table.skillId] })]);

export const workTypeVersionEquipment = sqliteTable("work_type_version_equipment", {
  workTypeVersionId: text("work_type_version_id").notNull().references(() => workTypeVersions.id, { onDelete: "cascade" }),
  equipmentId: text("equipment_id").notNull().references(() => equipmentItems.id, { onDelete: "restrict" }),
  quantity: real("quantity"), nameSnapshot: text("name_snapshot").notNull(), unitSnapshot: text("unit_snapshot").notNull(), usageSnapshot: text("usage_snapshot").notNull(),
}, table => [primaryKey({ columns: [table.workTypeVersionId, table.equipmentId] }), check("version_equipment_quantity_check", sql`${table.quantity} is null or ${table.quantity} > 0`)]);

export const workTypeVersionQualifications = sqliteTable("work_type_version_qualifications", {
  workTypeVersionId: text("work_type_version_id").notNull().references(() => workTypeVersions.id, { onDelete: "cascade" }),
  qualificationId: text("qualification_id").notNull().references(() => qualifications.id, { onDelete: "restrict" }),
}, (table) => [primaryKey({ columns: [table.workTypeVersionId, table.qualificationId] })]);

// Service objects and requests.
export const workerDayEquipment = sqliteTable("worker_day_equipment", {
  workerId: text("worker_id").notNull().references(() => workers.id, { onDelete: "cascade" }),
  serviceDate: text("service_date").notNull(),
  departedAt: text("departed_at").notNull(),
  equipmentJson: text("equipment_json"),
  source: text("source").notNull(),
  recordedByUserId: text("recorded_by_user_id").references(() => users.id, { onDelete: "set null" }),
  updatedAt: text("updated_at").notNull(),
}, table => [primaryKey({ columns: [table.workerId, table.serviceDate] })]);

export const serviceObjects = sqliteTable("service_objects", {
  id: text("id").primaryKey(), organizationId: text("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  externalReference: text("external_reference"), name: text("name").notNull(), address: text("address").notNull(), latitude: real("latitude"), longitude: real("longitude"),
  notes: text("notes").notNull().default(""), active: integer("active", { mode: "boolean" }).notNull().default(true), createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull(),
}, (table) => [uniqueIndex("service_objects_organization_external_unique").on(table.organizationId, table.externalReference), index("service_objects_organization_id_idx").on(table.organizationId), check("service_objects_latitude_check", sql`${table.latitude} is null or ${table.latitude} between -90 and 90`), check("service_objects_longitude_check", sql`${table.longitude} is null or ${table.longitude} between -180 and 180`)]);

export const workOrders = sqliteTable("work_orders", {
  categoryId: text("category_id").references(() => workCategories.id, { onDelete: "restrict" }),
  serviceDurationMinutes: integer("service_duration_minutes"), durationSource: text("duration_source").notNull().default("version"),
  revision: integer("revision").notNull().default(0),
  id: text("id").primaryKey(), organizationId: text("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  number: text("number").notNull(), workTypeVersionId: text("work_type_version_id").notNull().references(() => workTypeVersions.id, { onDelete: "restrict" }),
  serviceObjectId: text("service_object_id").references(() => serviceObjects.id, { onDelete: "set null" }), assigneeWorkerId: text("assignee_worker_id").references(() => workers.id, { onDelete: "set null" }),
  resourceId: text("resource_id").references(() => resources.id, { onDelete: "set null" }), createdByUserId: text("created_by_user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  confirmedByUserId: text("confirmed_by_user_id").references(() => users.id, { onDelete: "set null" }), description: text("description").notNull().default(""),
  priority: text("priority").notNull().default("medium"), status: text("status").notNull().default("new"), scheduledStart: text("scheduled_start").notNull(), scheduledEnd: text("scheduled_end"),
  addressSnapshot: text("address_snapshot").notNull(), latitudeSnapshot: real("latitude_snapshot"), longitudeSnapshot: real("longitude_snapshot"),
  buildingAddress: text("building_address").notNull().default(""), apartment: text("apartment").notNull().default(""),
  entrance: text("entrance").notNull().default(""), intercom: text("intercom").notNull().default(""),
  // Null means a legacy record with no explicit client window; never infer it from service duration.
  schedulingTimezone: text("scheduling_timezone"), clientWindowStart: text("client_window_start"), clientWindowEnd: text("client_window_end"),
  clientVisitConfirmed: integer("client_visit_confirmed", { mode: "boolean" }).notNull().default(false),
  completedAt: text("completed_at"), confirmedAt: text("confirmed_at"), createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull(),
}, (table) => [uniqueIndex("work_orders_organization_number_unique").on(table.organizationId, table.number), index("work_orders_organization_status_idx").on(table.organizationId, table.status), index("work_orders_assignee_schedule_idx").on(table.assigneeWorkerId, table.scheduledStart), index("work_orders_work_type_version_idx").on(table.workTypeVersionId), check("work_orders_priority_check", sql`${table.priority} in ('high', 'medium', 'low')`), check("work_orders_status_check", sql`${table.status} in ('new', 'assigned', 'en_route', 'in_progress', 'paused', 'completed', 'confirmed', 'cancelled')`)]);

export const workOrderWorkTypes = sqliteTable("work_order_work_types", {
  workOrderId: text("work_order_id").notNull().references(() => workOrders.id, { onDelete: "cascade" }),
  workTypeVersionId: text("work_type_version_id").notNull().references(() => workTypeVersions.id, { onDelete: "restrict" }),
  sequence: integer("sequence").notNull(), nameSnapshot: text("name_snapshot").notNull(),
}, table => [primaryKey({ columns: [table.workOrderId, table.workTypeVersionId] }), uniqueIndex("work_order_component_sequence_unique").on(table.workOrderId, table.sequence)]);

export const workOrderEquipment = sqliteTable("work_order_equipment", {
  workOrderId: text("work_order_id").notNull().references(() => workOrders.id, { onDelete: "cascade" }),
  equipmentId: text("equipment_id").notNull().references(() => equipmentItems.id, { onDelete: "restrict" }),
  quantity: real("quantity"), nameSnapshot: text("name_snapshot").notNull(), unitSnapshot: text("unit_snapshot").notNull(), usageSnapshot: text("usage_snapshot").notNull(),
}, table => [primaryKey({ columns: [table.workOrderId, table.equipmentId] }), check("order_equipment_quantity_check", sql`${table.quantity} is null or ${table.quantity} > 0`)]);

export const workOrderStatusHistory = sqliteTable("work_order_status_history", {
  id: text("id").primaryKey(), workOrderId: text("work_order_id").notNull().references(() => workOrders.id, { onDelete: "cascade" }),
  fromStatus: text("from_status"), toStatus: text("to_status").notNull(), changedByUserId: text("changed_by_user_id").references(() => users.id, { onDelete: "set null" }),
  reason: text("reason"), createdAt: text("created_at").notNull(),
}, (table) => [index("work_order_status_history_order_created_idx").on(table.workOrderId, table.createdAt)]);

// Daily planning and routing.
export const routePlanGroups = sqliteTable("route_plan_groups", {
  id: text("id").primaryKey(), serviceDate: text("service_date").notNull(),
  status: text("status").notNull().default("draft"),
  organizationIdsJson: text("organization_ids_json").notNull(), memberPlansJson: text("member_plans_json").notNull(),
  inputRevisionJson: text("input_revision_json").notNull(), publishedRevisionJson: text("published_revision_json"),
  resultJson: text("result_json").notNull(),
  createdByUserId: text("created_by_user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  publishedByUserId: text("published_by_user_id").references(() => users.id, { onDelete: "set null" }),
  createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull(), publishedAt: text("published_at"),
}, table => [index("route_plan_groups_date_idx").on(table.serviceDate), check("route_plan_groups_status_check", sql`${table.status} in ('draft', 'published', 'archived')`)]);

export const routePlans = sqliteTable("route_plans", {
  inputRevisionJson: text("input_revision_json"),
  resultJson: text("result_json"), publishedRevisionJson: text("published_revision_json"),
  id: text("id").primaryKey(), organizationId: text("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  serviceDate: text("service_date").notNull(), status: text("status").notNull().default("draft"), optimizerVersion: text("optimizer_version"),
  createdByUserId: text("created_by_user_id").notNull().references(() => users.id, { onDelete: "restrict" }), publishedByUserId: text("published_by_user_id").references(() => users.id, { onDelete: "set null" }),
  publishedAt: text("published_at"), createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull(),
}, (table) => [index("route_plans_organization_date_idx").on(table.organizationId, table.serviceDate), check("route_plans_status_check", sql`${table.status} in ('draft', 'published', 'archived')`)]);

export const routeStops = sqliteTable("route_stops", {
  id: text("id").primaryKey(), routePlanId: text("route_plan_id").notNull().references(() => routePlans.id, { onDelete: "cascade" }),
  workOrderId: text("work_order_id").notNull().references(() => workOrders.id, { onDelete: "cascade" }), workerId: text("worker_id").notNull().references(() => workers.id, { onDelete: "restrict" }),
  sequence: integer("sequence").notNull(), plannedStart: text("planned_start").notNull(), plannedEnd: text("planned_end"), travelMinutes: integer("travel_minutes"), createdAt: text("created_at").notNull(),
}, (table) => [uniqueIndex("route_stops_plan_order_unique").on(table.routePlanId, table.workOrderId), uniqueIndex("route_stops_plan_worker_sequence_unique").on(table.routePlanId, table.workerId, table.sequence), index("route_stops_worker_start_idx").on(table.workerId, table.plannedStart), check("route_stops_sequence_check", sql`${table.sequence} > 0`), check("route_stops_travel_minutes_check", sql`${table.travelMinutes} is null or ${table.travelMinutes} >= 0`)]);

// Completion reports, evidence and review.
export const workReports = sqliteTable("work_reports", {
  id: text("id").primaryKey(), workOrderId: text("work_order_id").notNull().references(() => workOrders.id, { onDelete: "cascade" }),
  performerWorkerId: text("performer_worker_id").notNull().references(() => workers.id, { onDelete: "restrict" }), revision: integer("revision").notNull(),
  status: text("status").notNull().default("draft"), comment: text("comment").notNull().default(""), fieldValuesJson: text("field_values_json").notNull().default("{}"),
  submittedAt: text("submitted_at"), acceptedAt: text("accepted_at"), createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull(),
}, (table) => [uniqueIndex("work_reports_order_revision_unique").on(table.workOrderId, table.revision), index("work_reports_status_submitted_idx").on(table.status, table.submittedAt), check("work_reports_revision_check", sql`${table.revision} > 0`), check("work_reports_status_check", sql`${table.status} in ('draft', 'submitted', 'manual_review', 'ai_queued', 'ai_review', 'accepted', 'changes_requested', 'rejected')`)]);

export const reportMedia = sqliteTable("report_media", {
  id: text("id").primaryKey(), reportId: text("report_id").notNull().references(() => workReports.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(), category: text("category").notNull().default("other"), storageKey: text("storage_key").notNull(), fileName: text("file_name").notNull(),
  mimeType: text("mime_type").notNull(), sizeBytes: integer("size_bytes").notNull(), checksum: text("checksum").notNull(), uploadStatus: text("upload_status").notNull().default("uploaded"),
  capturedAt: text("captured_at"), latitude: real("latitude"), longitude: real("longitude"), createdAt: text("created_at").notNull(),
}, (table) => [uniqueIndex("report_media_storage_key_unique").on(table.storageKey), index("report_media_report_id_idx").on(table.reportId), check("report_media_kind_check", sql`${table.kind} in ('photo', 'video')`), check("report_media_size_check", sql`${table.sizeBytes} >= 0`), check("report_media_upload_status_check", sql`${table.uploadStatus} in ('pending', 'uploaded', 'failed', 'deleted')`)]);

export const aiVerificationRuns = sqliteTable("ai_verification_runs", {
  id: text("id").primaryKey(), reportId: text("report_id").notNull().references(() => workReports.id, { onDelete: "cascade" }),
  connectionId: text("connection_id").notNull().references(() => aiVerifierConnections.id, { onDelete: "restrict" }), attempt: integer("attempt").notNull().default(1),
  status: text("status").notNull().default("queued"), result: text("result"), requestHash: text("request_hash").notNull(), externalRequestId: text("external_request_id"),
  errorCode: text("error_code"), errorMessage: text("error_message"), startedAt: text("started_at"), finishedAt: text("finished_at"), createdAt: text("created_at").notNull(),
}, (table) => [uniqueIndex("ai_verification_runs_report_attempt_unique").on(table.reportId, table.attempt), index("ai_verification_runs_status_idx").on(table.status), check("ai_verification_runs_attempt_check", sql`${table.attempt} > 0`), check("ai_verification_runs_status_check", sql`${table.status} in ('queued', 'running', 'succeeded', 'failed', 'cancelled')`), check("ai_verification_runs_result_check", sql`${table.result} is null or ${table.result} in ('accepted', 'not_accepted')`)]);

export const reportReviews = sqliteTable("report_reviews", {
  id: text("id").primaryKey(), reportId: text("report_id").notNull().references(() => workReports.id, { onDelete: "cascade" }),
  reviewerType: text("reviewer_type").notNull(), reviewerUserId: text("reviewer_user_id").references(() => users.id, { onDelete: "set null" }),
  aiVerificationRunId: text("ai_verification_run_id").references(() => aiVerificationRuns.id, { onDelete: "set null" }), decision: text("decision").notNull(),
  reason: text("reason"), createdAt: text("created_at").notNull(),
}, (table) => [index("report_reviews_report_created_idx").on(table.reportId, table.createdAt), check("report_reviews_reviewer_type_check", sql`${table.reviewerType} in ('dispatcher', 'ai_model')`), check("report_reviews_decision_check", sql`${table.decision} in ('accepted', 'changes_requested', 'rejected', 'not_accepted', 'error_fallback')`)]);

// Cross-cutting audit trail for role changes, planning and lifecycle decisions.
export const auditEvents = sqliteTable("audit_events", {
  id: text("id").primaryKey(), organizationId: text("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  actorUserId: text("actor_user_id").references(() => users.id, { onDelete: "set null" }), entityType: text("entity_type").notNull(), entityId: text("entity_id").notNull(),
  action: text("action").notNull(), payloadJson: text("payload_json").notNull().default("{}"), createdAt: text("created_at").notNull(),
}, (table) => [index("audit_events_organization_created_idx").on(table.organizationId, table.createdAt), index("audit_events_entity_idx").on(table.entityType, table.entityId, table.createdAt)]);

export const mobileSessionBindings = sqliteTable("mobile_session_bindings", {
  sessionId: text("session_id").primaryKey().references(() => sessions.id, { onDelete: "cascade" }),
  workerId: text("worker_id").notNull().references(() => workers.id, { onDelete: "cascade" }),
  organizationId: text("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
});

// accepted is a transactional assertion: a failed precondition rolls back the whole D1 batch.
export const mobileCommands = sqliteTable("mobile_commands", {
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  operationId: text("operation_id").notNull(), fingerprint: text("fingerprint").notNull(),
  accepted: integer("accepted").notNull(), createdAt: text("created_at").notNull(),
}, (table) => [primaryKey({ columns: [table.userId, table.operationId] }), check("mobile_command_precondition", sql`${table.accepted} = 1`)]);

export const mobileIssues = sqliteTable("mobile_issues", {
  id: text("id").primaryKey(), workOrderId: text("work_order_id").notNull().references(() => workOrders.id, { onDelete: "cascade" }),
  workerId: text("worker_id").notNull().references(() => workers.id, { onDelete: "restrict" }),
  reason: text("reason").notNull(), detail: text("detail").notNull(), createdAt: text("created_at").notNull(),
}, (table) => [index("mobile_issues_order_created_idx").on(table.workOrderId, table.createdAt)]);

export const mobileNoticeReads = sqliteTable("mobile_notice_reads", {
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  eventId: text("event_id").notNull(), readAt: text("read_at").notNull(),
}, (table) => [primaryKey({ columns: [table.userId, table.eventId] })]);

export const dispatcherNotifications = sqliteTable("dispatcher_notifications", {
  sequence: integer("sequence").primaryKey({ autoIncrement: true }),
  organizationId: text("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  workOrderId: text("work_order_id").notNull().references(() => workOrders.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(), detail: text("detail").notNull(), createdAt: text("created_at").notNull(),
}, table => [index("dispatcher_notifications_scope_sequence_idx").on(table.organizationId, table.sequence), check("dispatcher_notification_kind", sql`${table.kind} in ('status', 'problem')`)]);

export const dispatcherNotificationReads = sqliteTable("dispatcher_notification_reads", {
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  sequence: integer("sequence").notNull().references(() => dispatcherNotifications.sequence, { onDelete: "cascade" }),
  readAt: text("read_at").notNull(),
}, table => [primaryKey({ columns: [table.userId, table.sequence] })]);

export const dispatcherNotificationCursors = sqliteTable("dispatcher_notification_cursors", {
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  organizationId: text("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  deliveredSequence: integer("delivered_sequence").notNull().default(0),
}, table => [primaryKey({ columns: [table.userId, table.organizationId] })]);
