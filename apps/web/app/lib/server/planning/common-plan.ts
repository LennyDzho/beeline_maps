import { serializePlanningResult, deserializePlanningResult } from "./result-storage";
import type { PlanningResult } from "@/app/dispatcher/planning-types";
import { regionalTimeToInstant } from "@/app/lib/regional-time";
import { planningInputExpression } from "./input-revisions";
import { PlanningServiceError, planningErrorResponse, publishPlan, recalculatePlan } from "./planning-service";
import { loadPlanningSettings } from "./settings-storage";
import { DEFAULT_CALCULATION_TIMEOUT_SECONDS } from "../../planning-settings";

export type PlanningDepartment = { id: string; name: string; timezone: string };
type Member = { organizationId: string; planId: string | null };
type Group = { id: string; service_date: string; status: string; organization_ids_json: string; member_plans_json: string;
  input_revision_json: string; published_revision_json: string | null; result_json: string };

const accessibleDepartments = `SELECT DISTINCT o.id, o.name, o.timezone FROM organizations o
  JOIN memberships m ON m.organization_id=o.id JOIN role_permissions p ON p.role_id=m.role_id
  WHERE o.status='active' AND m.status='active' AND m.user_id=? AND p.permission_code='planning.manage' ORDER BY o.id`;
const scopeExpression = `(SELECT json_group_array(id) FROM (${accessibleDepartments}))`;
// The same expression runs inside the publication transaction, including empty departments.
const commonInputExpression = `(SELECT json_group_array(json_array(scope.organization_id,json(${planningInputExpression})))
  FROM (SELECT value AS organization_id FROM json_each(g.organization_ids_json) ORDER BY value) scope)`;
const membersIntact = `NOT EXISTS (SELECT 1 FROM json_each(g.member_plans_json) member
  WHERE json_extract(member.value,'$.planId') IS NOT NULL AND NOT EXISTS
    (SELECT 1 FROM route_plans p WHERE p.id=json_extract(member.value,'$.planId')
      AND p.organization_id=json_extract(member.value,'$.organizationId') AND p.status=g.status AND p.service_date=g.service_date))`;

export async function listPlanningDepartments(database: D1Database, userId: string) {
  return (await database.prepare(accessibleDepartments).bind(userId).all<PlanningDepartment>()).results;
}

function assertDate(date: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0,10)!==date)
    throw new PlanningServiceError("INVALID_DATE", "Укажите дату планирования.", 400);
}
function stale() { return new PlanningServiceError("INVALID_PLAN", "Данные, состав подразделений или права доступа изменились. Пересчитайте общий план.", 409); }
function emptyMetrics(): PlanningResult["metrics"] { return {totalJobs:0,plannedJobs:0,unassignedJobs:0,engineersUsed:0,totalEngineers:0,totalTravelMinutes:0,totalDistanceKm:0,hardViolations:0,score:0}; }

async function readInput(database: D1Database, scope: string) {
  return (await database.prepare(`SELECT ${commonInputExpression} AS snapshot FROM (SELECT ? AS organization_ids_json) g`)
    .bind(scope).first<{snapshot:string}>())!.snapshot;
}

function guard(database: D1Database, userId: string, scope: string, revision: string, groupId: string | null) {
  return database.prepare(`INSERT INTO mobile_commands (user_id,operation_id,fingerprint,accepted,created_at)
    SELECT ?,?,'common-plan',CASE WHEN ${scopeExpression}=? AND ${commonInputExpression}=?
      AND (? IS NULL OR EXISTS (SELECT 1 FROM route_plan_groups g WHERE g.id=? AND g.status='draft'
        AND g.organization_ids_json=? AND g.input_revision_json=? AND ${membersIntact}))
      THEN 1 ELSE 0 END,? FROM (SELECT ? AS organization_ids_json) g`)
    .bind(userId,crypto.randomUUID(),userId,scope,revision,groupId,groupId,scope,revision,new Date().toISOString(),scope);
}
async function commit(database: D1Database, statements: D1PreparedStatement[]) {
  try { await database.batch(statements); }
  catch (error) { if (String(error).includes("mobile_command_precondition")) throw stale(); throw error; }
}

export async function recalculateCommonPlan(database: D1Database, userId: string, date: string, eventTime?: string, requestSignal?: AbortSignal) {
  const settings = await loadPlanningSettings(database);
  const timeoutSeconds = settings.calculationTimeoutSeconds ?? DEFAULT_CALCULATION_TIMEOUT_SECONDS;
  const deadline = AbortSignal.timeout(timeoutSeconds * 1000);
  const signal = requestSignal ? AbortSignal.any([requestSignal, deadline]) : deadline;
  const checkDeadline = () => {
    if (signal.aborted) throw new PlanningServiceError("DEPARTMENT_ERROR", deadline.aborted
      ? `Расчёт не завершился за ${timeoutSeconds} с. Черновик не изменён. Проверьте сервис маршрутизации или увеличьте максимальное время расчёта в настройках планирования.`
      : "Расчёт отменён. Черновик не изменён.", deadline.aborted ? 504 : 409);
  };
  assertDate(date);
  if (eventTime !== undefined && !/^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(eventTime))
    throw new PlanningServiceError("INVALID_DATE", "Время события задаётся как ЧЧ:ММ по местному времени каждого подразделения.",400);
  const departments = await listPlanningDepartments(database,userId);
  if (!departments.length) throw new PlanningServiceError("NOT_FOUND", "Нет доступных подразделений для планирования.",403);
  const scope=JSON.stringify(departments.map(d=>d.id)), revision=await readInput(database,scope);
  const writes: D1PreparedStatement[]=[], members: Member[]=[], results: PlanningResult[]=[];
  const result: PlanningResult={planId:`COMMON-${crypto.randomUUID()}`,serviceDate:date,status:"draft",providerId:"",optimizerId:"",
    metrics:emptyMetrics(),routes:[],previousRoutes:[],unassigned:[],warnings:[],changes:[],clientApprovals:[],protectedJobIds:[],departments:[]};
  for (const department of departments) {
    checkDeadline();
    const orders=(await database.prepare("SELECT id,status,assignee_worker_id FROM work_orders WHERE organization_id=? AND SUBSTR(scheduled_start,1,10)=? AND status<>'cancelled' ORDER BY id")
      .bind(department.id,date).all<{id:string;status:string;assignee_worker_id:string|null}>()).results;
    const workers=(await database.prepare("SELECT id FROM workers WHERE organization_id=? AND active=1 ORDER BY id").bind(department.id).all<{id:string}>()).results;
    let child: PlanningResult | null=null;
    if (orders.some(o=>["new","assigned"].includes(o.status))) {
      const settings=await loadPlanningSettings(database);
      try {
        child=await recalculatePlan(database,department.id,userId,date,eventTime===undefined ? undefined : regionalTimeToInstant(`${date}T${eventTime}`,department.timezone),
          async statements=>{writes.push(...statements);}, signal);
      } catch (error) {
        checkDeadline();
        const known=planningErrorResponse(error);
        if (!known) throw error;
        const source=settings.travelMatrixProvider==='osrm' ? 'OSRM / OpenStreetMap' : '2ГИС';
        throw new PlanningServiceError('DEPARTMENT_ERROR',`${department.name} · источник расчёта ${source}: ${known.message}`,known.status);
      }
      results.push(child);
    }
    const protectedOrders=orders.filter(o=>!["new","assigned"].includes(o.status));
    const metrics=child?.metrics ?? {...emptyMetrics(),totalEngineers:workers.length,engineersUsed:new Set(protectedOrders.map(o=>o.assignee_worker_id).filter(Boolean)).size};
    members.push({organizationId:department.id,planId:child?.planId ?? null});
    result.departments!.push({...department,planId:child?.planId ?? null,jobIds:orders.map(o=>o.id),workerIds:workers.map(w=>w.id),planningAt:child?.planningAt,providerId:child?.providerId,optimizerId:child?.optimizerId,metrics});
    for (const key of Object.keys(metrics) as Array<keyof typeof metrics>) result.metrics[key]+=metrics[key];
    result.routes.push(...child?.routes ?? []); result.unassigned.push(...child?.unassigned ?? []);
    result.previousRoutes!.push(...child?.previousRoutes ?? []);
    result.changes!.push(...child?.changes ?? []); result.clientApprovals!.push(...child?.clientApprovals ?? []);
    result.protectedJobIds!.push(...child?.protectedJobIds ?? protectedOrders.map(o=>o.id));
    result.warnings.push(...(child?.warnings ?? []).map(w=>`${department.name}: ${w}`));
  }
  if (!results.length) throw new PlanningServiceError("NO_JOBS",`На ${date} нет заявок для планирования в доступных подразделениях.`,404);
  result.providerId=[...new Set(results.map(r=>r.providerId))].join(" + ");
  result.optimizerId=[...new Set(results.map(r=>r.optimizerId))].join(" + ");
  const now=new Date().toISOString();
  checkDeadline();
  await commit(database,[guard(database,userId,scope,revision,null),
    database.prepare(`UPDATE route_plan_groups SET status='archived',updated_at=? WHERE service_date=? AND status='draft'
      AND EXISTS (SELECT 1 FROM json_each(organization_ids_json) WHERE value IN (SELECT value FROM json_each(?)))`).bind(now,date,scope),
    ...writes,
    database.prepare(`INSERT INTO route_plan_groups (id,service_date,status,organization_ids_json,member_plans_json,input_revision_json,result_json,created_by_user_id,created_at,updated_at)
      VALUES (?,?,'draft',?,?,?,?,?,?,?)`).bind(result.planId,date,scope,JSON.stringify(members),revision,await serializePlanningResult(result),userId,now,now),
  ]);
  return result;
}

export async function readCommonPlan(database: D1Database,userId: string,date: string,planId?: string,publishedOnly=false) {
  assertDate(date);
  const scope=JSON.stringify((await listPlanningDepartments(database,userId)).map(d=>d.id));
  const group=await database.prepare(`SELECT * FROM route_plan_groups WHERE service_date=? AND organization_ids_json=?
    ${planId ? "AND id=?" : publishedOnly ? "AND status='published'" : "AND status IN ('draft','published')"}
    ORDER BY CASE status WHEN 'draft' THEN 0 ELSE 1 END,created_at DESC,rowid DESC LIMIT 1`)
    .bind(date,scope,...(planId ? [planId] : [])).first<Group>();
  if (!group) {
    if (planId) throw new PlanningServiceError("NOT_FOUND","Общий план недоступен в текущем составе подразделений.",404);
    return {result:null,outdated:false};
  }
  const expected=group.status==='draft' ? group.input_revision_json : group.published_revision_json;
  const intact=await database.prepare(`SELECT 1 FROM route_plan_groups g WHERE id=? AND status IN ('draft','published') AND ${membersIntact}`).bind(group.id).first();
  const result={...await deserializePlanningResult(group.result_json),status:group.status as "draft"|"published"};
  const settings=await loadPlanningSettings(database);
  const provider=settings.travelMatrixProvider==='osrm' ? 'osrm' : '2gis';
  const optimizer=settings.optimizationEngine==='two_gis_tsp' ? '2gis-tsp-vrp/' : `${settings.optimizationEngine}-routing/`;
  const methodsChanged=result.providerId.split(' + ').some(id=>id!==provider)
    || result.optimizerId.split(' + ').some(id=>!id.startsWith(optimizer));
  if (!intact || expected!==await readInput(database,scope)) {
    // Historical geometry is useful for viewing, but never authorizes publication.
    return {result:null,outdated:true,methodsChanged,displayResult:intact && !methodsChanged ? result : null};
  }
  return {result,outdated:false,methodsChanged:false};
}

export async function publishCommonPlan(database: D1Database,userId: string,planId: string,acknowledgements: string[]) {
  const scope=JSON.stringify((await listPlanningDepartments(database,userId)).map(d=>d.id));
  const group=await database.prepare("SELECT * FROM route_plan_groups WHERE id=? AND organization_ids_json=?").bind(planId,scope).first<Group>();
  if (!group) throw new PlanningServiceError("NOT_FOUND","Общий план недоступен в текущем составе подразделений.",404);
  if (group.status!=="draft" || group.input_revision_json!==await readInput(database,scope)) throw stale();
  const result=await deserializePlanningResult(group.result_json);
  const required=result.clientApprovals ?? [];
  if (acknowledgements.length!==required.length || required.some(a=>!acknowledgements.includes(a.id)))
    throw new PlanningServiceError("INVALID_PLAN","Подтвердите сообщение клиентам во всех подразделениях общего плана.",409);
  const writes: D1PreparedStatement[]=[];
  for (const member of JSON.parse(group.member_plans_json) as Member[]) if (member.planId) {
    const childId=member.planId;
    await publishPlan(database,member.organizationId,userId,childId,acknowledgements.filter(id=>id.startsWith(`${childId}:`)),async statements=>{writes.push(...statements);});
  }
  const now=new Date().toISOString();
  await commit(database,[guard(database,userId,scope,group.input_revision_json,group.id),...writes,
    database.prepare(`UPDATE route_plan_groups SET status='archived',updated_at=? WHERE service_date=? AND status='published'
      AND EXISTS (SELECT 1 FROM json_each(organization_ids_json) WHERE value IN (SELECT value FROM json_each(?)))`).bind(now,group.service_date,scope),
    database.prepare(`UPDATE route_plan_groups AS g SET status='published',published_by_user_id=?,published_at=?,updated_at=?,result_json=?,
      published_revision_json=${commonInputExpression} WHERE id=?`).bind(userId,now,now,await serializePlanningResult(result),planId),
  ]);
  return {planId,status:"published" as const,serviceDate:group.service_date,publishedAt:now,plannedJobs:result.metrics.plannedJobs,unassignedJobs:result.metrics.unassignedJobs};
}
