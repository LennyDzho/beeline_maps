import prepared from "@/data/beeline-import.json";
import { initialRoles, permissionCatalog } from "@/app/admin/role-data";
import { addMinutesToTimestamp } from "@/app/lib/planned-duration";

export const beelineManifest = prepared;

export function beelinePreview() {
  return { version: prepared.datasetVersion, contentHash: prepared.contentHash, serviceDate: prepared.serviceDate,
    counts: prepared.counts, warnings: prepared.warnings, assumedCoordinates: prepared.assumedCoordinates,
    sourceFiles: prepared.sourceFiles, excludedJobs: prepared.excludedJobs,
    divisions: prepared.divisions.map(division => ({ ...division,
      workers: prepared.workers.filter(worker => worker.divisionId === division.id).length,
      jobs: prepared.jobs.filter(job => job.divisionId === division.id).length,
      newJobs: prepared.jobs.filter(job => job.divisionId === division.id && job.status === "new").length })),
    jobs: prepared.jobs.map(job => ({ id: job.id, divisionId: job.divisionId, number: job.number, address: job.address,
      categoryName: job.categoryName, workNames: job.workNames, status: job.status, clientWindowStart: job.clientWindowStart,
      clientWindowEnd: job.clientWindowEnd, serviceDurationMinutes: job.serviceDurationMinutes, durationSource: job.durationSource,
      syntheticRow: job.source.syntheticRow, controlId: job.source.controlId, coordinatesAssumed: Boolean(job.geocodingProvenance?.isAssumption) })),
  };
}
export type BeelinePreview = ReturnType<typeof beelinePreview>;

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical((value as Record<string, unknown>)[key])]));
  return value;
}

async function verifyManifest() {
  const { contentHash, ...body } = prepared;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(canonical(body))));
  const actual = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
  if (actual !== contentHash) throw new Error("Нарушена контрольная сумма подготовленного набора. Повторите подготовку импорта.");
}

/** For the release transition and isolated acceptance copies. Never clears data.
 * The empty-target check runs INSIDE the same atomic batch as all inserted rows.
 * Same-version retries are no-ops: edited orders must not be reset by reimport.
 */
export async function importBeelineIntoEmptyDatabase(database: D1Database, administratorId: string) {
  await verifyManifest();
  const prepared = sharedImportCatalog(beelineManifest);
  const installed = await database.prepare("SELECT version, content_hash FROM dataset_imports WHERE version=?")
    .bind(prepared.datasetVersion).first<{ version: string; content_hash: string }>();
  if (installed) {
    const active = await database.prepare("SELECT version FROM application_dataset WHERE id=1").first<{ version: string }>();
    if (installed.content_hash !== prepared.contentHash || active?.version !== prepared.datasetVersion) throw new Error("Версия набора отличается от установленной. Нужен отдельный переход данных.");
    return { imported: false, version: installed.version, counts: prepared.counts };
  }
  const administrator = await database.prepare("SELECT id FROM users WHERE id=? AND role IN ('admin','administrator') AND status='active'")
    .bind(administratorId).first();
  if (!administrator) throw new Error("Для импорта нужен действующий администратор.");
  const now = new Date().toISOString();
  const records: Array<{ sql: string; values: (string | number | null)[] }> = [];
  const add = (sql: string, ...values: (string | number | null)[]) => records.push({ sql, values });
  add(`INSERT INTO dataset_imports (version,content_hash,manifest_json,imported_by_user_id,imported_at,empty_target_guard)
    SELECT ?,?,?,?,?,CASE WHEN NOT EXISTS(SELECT 1 FROM organizations) AND NOT EXISTS(SELECT 1 FROM work_orders)
      AND NOT EXISTS(SELECT 1 FROM workers) AND NOT EXISTS(SELECT 1 FROM route_plan_groups)
      AND NOT EXISTS(SELECT 1 FROM application_dataset) THEN 1 ELSE 0 END`,
  prepared.datasetVersion, prepared.contentHash, JSON.stringify(beelineManifest), administratorId, now);
  for (const permission of permissionCatalog) add("INSERT OR IGNORE INTO permissions (code,name,description) VALUES (?,?,?)", permission.id, permission.label, permission.description);
  for (const division of prepared.divisions) {
    add(`INSERT INTO organizations (id,name,timezone,application_name,office_address,office_latitude,office_longitude,created_at,updated_at)
      VALUES (?,?,?,'Марш!',?,?,?,?,?)`, division.id, division.name, division.timezone, division.officeAddress, division.officeCoordinates.lat, division.officeCoordinates.lon, now, now);
    for (const role of initialRoles) {
      const id = `${division.id}:${role.id}`;
      add("INSERT INTO roles (id,organization_id,code,name,description,is_system,created_at,updated_at) VALUES (?,?,?,?,?,1,?,?)", id, division.id, role.id, role.name, role.description, now, now);
      for (const permission of role.permissions) add("INSERT INTO role_permissions (role_id,permission_code) VALUES (?,?)", id, permission);
    }
    add("INSERT INTO memberships (id,organization_id,user_id,role_id,status,created_at,updated_at) VALUES (?,?,?,?,'active',?,?)",
      `${division.id}:${administratorId}`, division.id, administratorId, `${division.id}:administrator`, now, now);
    const scheduleId = `${division.id}-schedule`;
    add("INSERT INTO work_schedules (id,organization_id,name,active,created_at,updated_at) VALUES (?,?,?,1,?,?)", scheduleId, division.id, "Смена 09:00–22:00", now, now);
    for (let day = 1; day <= 7; day++) add("INSERT INTO work_schedule_days (schedule_id,weekday,enabled,start_time,end_time) VALUES (?,?,1,?,?)", scheduleId, day, division.schedule.start, division.schedule.end);
  }
  for (const category of prepared.categories) add(`INSERT INTO work_categories (id,organization_id,name,description,service_duration_minutes,duration_source,created_at,updated_at)
    VALUES (?,?,?,'',?,?,?,?)`, category.id, category.divisionId, category.name, category.serviceDurationMinutes, category.durationSource, now, now);
  for (const type of prepared.workTypes) {
    add("INSERT INTO work_types (id,organization_id,code,name,description,created_at,updated_at) VALUES (?,?,?,?,?,?,?)", type.id, type.divisionId, type.id, type.name, type.durationSource, now, now);
    add(`INSERT INTO work_type_versions (id,work_type_id,version,status,planned_duration_minutes,verification_mode,published_by_user_id,published_at,created_at,is_emergency)
      VALUES (?,?,1,'published',?,'dispatcher',?,?,?,?)`, `${type.id}-v1`, type.id, type.defaultDurationMinutes, administratorId, now, now, Number(type.name.trim().toLocaleLowerCase('ru')==='авария'));
    for (const categoryId of type.categoryIds) add("INSERT INTO category_work_types (category_id,work_type_id) VALUES (?,?)", categoryId, type.id);
    if (type.name === "Заявка на подключение") add("INSERT INTO work_type_aliases (organization_id,alias,work_type_id) VALUES (?,'заказ подключения',?)", type.divisionId, type.id);
  }
  for (const worker of prepared.workers) {
    add(`INSERT INTO workers (id,organization_id,work_schedule_id,employee_number,full_name,phone,timezone,shift_status,transport_mode,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,'on_shift',?,?,?)`, worker.id, worker.divisionId, `${worker.divisionId}-schedule`, worker.id, worker.name, worker.phone, worker.timezone, worker.transportMode, now, now);
    for (const competency of worker.competencies) add("INSERT INTO worker_work_competencies (worker_id,category_id,work_type_id) VALUES (?,?,?)", worker.id, competency.categoryId, competency.workTypeId);
  }
  for (const job of prepared.jobs) {
    const orderId = crypto.randomUUID();
    add(`INSERT INTO work_orders (id,organization_id,number,work_type_version_id,category_id,assignee_worker_id,created_by_user_id,
      description,priority,status,scheduled_start,scheduled_end,address_snapshot,building_address,apartment,entrance,intercom,
      latitude_snapshot,longitude_snapshot,scheduling_timezone,client_window_start,client_window_end,service_duration_minutes,duration_source,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, orderId, job.divisionId, job.number, `${job.workTypeIds[0]}-v1`, job.categoryId,
    job.assigneeId, administratorId, job.workNames.join(" + "), job.priority, job.status, job.clientWindowStart,
    job.status === "new" ? addMinutesToTimestamp(job.clientWindowStart, job.serviceDurationMinutes) : null,
    job.address, job.buildingAddress, job.apartment, job.entrance, job.intercom, job.coordinates?.lat ?? null, job.coordinates?.lon ?? null,
    job.timezone, `${job.clientWindowStart}:00+03:00`, `${job.clientWindowEnd}:00+03:00`, job.serviceDurationMinutes, job.durationSource, now, now);
    for (const [index, id] of job.workTypeIds.entries()) add("INSERT INTO work_order_work_types (work_order_id,work_type_version_id,sequence,name_snapshot) VALUES (?,?,?,?)", orderId, `${id}-v1`, index, job.workNames[index]);
    add("INSERT INTO work_order_status_history (id,work_order_id,to_status,changed_by_user_id,reason,created_at) VALUES (?,?,?,?,?,?)", crypto.randomUUID(), orderId, job.status, administratorId,
      job.status === "completed" ? "Выполнена по контрольному распределению; фактическое время в источнике не задано." : "Заявка загружена", now);
  }
  add("INSERT INTO application_dataset (id,version,updated_at) VALUES (1,?,?)", prepared.datasetVersion, now);
  // D1 has per-invocation query and binding limits. Group repeated INSERTs into
  // JSON rowsets (one binding each), retaining dependency order and one batch.
  // https://developers.cloudflare.com/d1/platform/limits/
  const groups = new Map<string, typeof records>();
  for (const record of records) groups.set(record.sql, [...groups.get(record.sql) ?? [], record]);
  const statements = [...groups].map(([sql, group]) => {
    const insert = /^(INSERT[\s\S]+?)VALUES\s*\(([\s\S]+)\)$/u.exec(sql.trim());
    if (group.length === 1 || !insert) return database.prepare(sql).bind(...group[0].values);
    let index = 0;
    const columns = insert[2].replace(/\?/gu, () => `json_extract(value, '$[${index++}]')`);
    return database.prepare(`${insert[1]}SELECT ${columns} FROM json_each(?)`).bind(JSON.stringify(group.map(record => record.values)));
  });
  await database.batch(statements);
  return { imported: true, version: prepared.datasetVersion, counts: prepared.counts };
}

/** The source manifest remains immutable; operational records use shared identities. */
function sharedImportCatalog(source: typeof beelineManifest): typeof beelineManifest {
  const result = structuredClone(source);
  const categories = new Map<string, typeof result.categories[number]>();
  const categoryIds = new Map<string, string>();
  for (const item of [...result.categories].sort((a,b)=>a.id.localeCompare(b.id))) {
    const canonical = categories.get(item.name) ?? item;
    categories.set(item.name, canonical); categoryIds.set(item.id, canonical.id);
  }
  const types = new Map<string, typeof result.workTypes[number]>();
  const typeIds = new Map<string, string>();
  for (const item of [...result.workTypes].sort((a,b)=>a.id.localeCompare(b.id))) {
    const canonical = types.get(item.name) ?? {...item,categoryIds:[]};
    canonical.categoryIds = [...new Set([...canonical.categoryIds,...item.categoryIds.map(id=>categoryIds.get(id)!)])];
    types.set(item.name, canonical); typeIds.set(item.id, canonical.id);
  }
  result.categories=[...categories.values()]; result.workTypes=[...types.values()];
  for(const worker of result.workers) worker.competencies=worker.competencies.map(item=>({...item,categoryId:categoryIds.get(item.categoryId)!,workTypeId:typeIds.get(item.workTypeId)!}));
  for(const job of result.jobs) { job.categoryId=categoryIds.get(job.categoryId)!;job.workTypeIds=job.workTypeIds.map(id=>typeIds.get(id)!); }
  return result;
}
