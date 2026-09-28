import { NextResponse } from "next/server";
import type { VerificationMethodId, WorkTypeRecord } from "@/app/admin/work-type-data";
import { listWorkTypes } from "@/app/api/admin/_data";
import { badRequest, isApiError, readJsonObject, requireApiContext, serverError } from "@/app/api/_shared";
import { isPlannedDurationMinutes } from "@/app/lib/planned-duration";
import { parseReportTemplate, parseEvidencePolicy } from "@/app/lib/report-requirements";
import { isQualificationIds } from "@/app/admin/qualification-data";
import { resolveQualificationIds } from "@/app/lib/server/qualifications";
import { isSkillIds } from "@/app/admin/skill-data";
import { resolveSkillIds } from "@/app/lib/server/skills";

import { canonicalWorkName, isUniqueIds, isEquipmentRequirements, type EquipmentRequirement } from "@/app/lib/work-catalog";
import { workTypeCatalogStatements, WorkCatalogError } from "@/app/lib/server/work-catalog";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const context = await requireApiContext(request, "admin.settings");
    if (isApiError(context)) return context;
    const payload = parsePayload(await readJsonObject(request));
    if (!payload) return badRequest();
    const numeric = await context.database.prepare("SELECT MAX(CAST(SUBSTR(id, 6) AS INTEGER)) AS value FROM work_types WHERE id LIKE 'WORK-%'").first<{ value: number | null }>();
    const id = `WORK-${String((numeric?.value ?? 0) + 1).padStart(3, "0")}`;
    const refs = await resolveReferences(context.database, context.organizationId, payload);
    if (!refs) return badRequest("Проверьте модель проверки, навыки и квалификации.");
    const now = new Date().toISOString();
    const versionId = `${id}-V1`;
    const catalogStatements = await workTypeCatalogStatements(context.database, context.organizationId, id, versionId, payload.name, payload.categoryIds, payload.equipmentRequirements);
    const statements = [
      context.database.prepare(`INSERT INTO work_types (id, organization_id, code, name, description, active, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 1, ?, ?)`).bind(id, context.organizationId, id, payload.name, payload.description, now, now),
      context.database.prepare(`INSERT INTO work_type_versions
        (id, work_type_id, version, status, planned_duration_minutes, verification_mode, ai_verifier_connection_id, report_template_json, evidence_policy_json, published_by_user_id, published_at, created_at, is_emergency, auto_accept_report)
        VALUES (?, ?, 1, 'published', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(versionId, id, payload.plannedDurationMinutes, refs.mode, refs.connectionId, JSON.stringify(payload.reportTemplate ?? {}), JSON.stringify(payload.evidencePolicy ?? {}), context.user.id, now, now, Number(payload.isEmergency ?? payload.name.toLocaleLowerCase('ru')==='авария'), refs.autoAccept),
      ...refs.skillIds.map((skillId) => context.database.prepare("INSERT INTO work_type_version_skills (work_type_version_id, skill_id) VALUES (?, ?)").bind(versionId, skillId)),
      ...refs.qualificationIds.map((qualificationId) => context.database.prepare("INSERT INTO work_type_version_qualifications (work_type_version_id, qualification_id) VALUES (?, ?)").bind(versionId, qualificationId)),
    ];
    await context.database.batch([...statements, ...catalogStatements]);
    const items = await listWorkTypes(context.database);
    return NextResponse.json({ item: items.find((item) => item.id === id) }, { status: 201 });
  } catch (error) { return catalogError(error); }
}

export async function PUT(request: Request) {
  try {
    const context = await requireApiContext(request, "admin.settings");
    if (isApiError(context)) return context;
    const body = await readJsonObject(request);
    const payload = parsePayload(body);
    if (!payload || typeof body?.id !== "string") return badRequest();
    const current = await context.database.prepare(`SELECT v.id, v.version, v.is_emergency, v.report_template_json, v.evidence_policy_json FROM work_type_versions v
      JOIN work_types wt ON wt.id = v.work_type_id WHERE wt.id = ? ORDER BY v.version DESC LIMIT 1`).bind(body.id).first<{ id: string; version: number; is_emergency: number; report_template_json:string; evidence_policy_json:string }>();
    if (!current?.version) return NextResponse.json({ message: "Тип работ не найден." }, { status: 404 });
    const retained = await context.database.prepare(`SELECT vq.qualification_id FROM work_type_version_qualifications vq
      JOIN work_type_versions v ON v.id = vq.work_type_version_id WHERE v.work_type_id = ? AND v.version = ?`)
      .bind(body.id, current.version).all<{ qualification_id: string }>();
    const retainedSkills = await context.database.prepare(`SELECT vs.skill_id FROM work_type_version_skills vs
      JOIN work_type_versions v ON v.id = vs.work_type_version_id WHERE v.work_type_id = ? AND v.version = ?`)
      .bind(body.id, current.version).all<{ skill_id: string }>();
    const refs = await resolveReferences(context.database, context.organizationId, payload, retained.results.map((row) => row.qualification_id), retainedSkills.results.map((row) => row.skill_id));
    if (!refs) return badRequest("Проверьте модель проверки, навыки и квалификации.");
    const version = current.version + 1;
    const versionId = `${body.id}-V${version}`;
    const now = new Date().toISOString();
    const catalogStatements = await workTypeCatalogStatements(context.database, context.organizationId, body.id, versionId, payload.name, payload.categoryIds, payload.equipmentRequirements, current.id);
    const statements = [
      context.database.prepare("UPDATE work_types SET name = ?, description = ?, updated_at = ? WHERE id = ?").bind(payload.name, payload.description, now, body.id),
      context.database.prepare("UPDATE work_type_versions SET status = 'archived' WHERE work_type_id = ? AND status = 'published'").bind(body.id),
      context.database.prepare(`INSERT INTO work_type_versions
        (id, work_type_id, version, status, planned_duration_minutes, verification_mode, ai_verifier_connection_id, report_template_json, evidence_policy_json, published_by_user_id, published_at, created_at, is_emergency, auto_accept_report)
        VALUES (?, ?, ?, 'published', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(versionId, body.id, version, payload.plannedDurationMinutes, refs.mode, refs.connectionId, payload.reportTemplate===undefined ? current.report_template_json : JSON.stringify(payload.reportTemplate), payload.evidencePolicy===undefined ? current.evidence_policy_json : JSON.stringify(payload.evidencePolicy), context.user.id, now, now, Number(payload.isEmergency ?? Boolean(current.is_emergency)), refs.autoAccept),
      ...refs.skillIds.map((skillId) => context.database.prepare("INSERT INTO work_type_version_skills (work_type_version_id, skill_id) VALUES (?, ?)").bind(versionId, skillId)),
      ...refs.qualificationIds.map((qualificationId) => context.database.prepare("INSERT INTO work_type_version_qualifications (work_type_version_id, qualification_id) VALUES (?, ?)").bind(versionId, qualificationId)),
    ];
    await context.database.batch([...statements, ...catalogStatements]);
    const items = await listWorkTypes(context.database);
    return NextResponse.json({ item: items.find((item) => item.id === body.id) });
  } catch (error) { return catalogError(error); }
}

function parsePayload(body: Record<string, unknown> | null): WorkTypeRecord | null {
  if (body?.reportTemplate!==undefined && !parseReportTemplate(body.reportTemplate)) return null;
  if (body?.evidencePolicy!==undefined && !parseEvidencePolicy(body.evidencePolicy)) return null;
  if (body?.isEmergency !== undefined && typeof body.isEmergency !== 'boolean') return null;
  if (!body || !isText(body.name) || typeof body.description !== "string" || !isPlannedDurationMinutes(body.plannedDurationMinutes) || !isVerification(body.verificationMethodId) || !isStringArray(body.requiredSkills) || !isStringArray(body.requiredQualifications)) return null;
  const hd = Array.isArray(body.categoryIds) && body.categoryIds.length > 0;
  if (!hd && (!body.requiredSkills.length || !body.requiredQualifications.length)) return null;
  if (body.categoryIds !== undefined && !isUniqueIds(body.categoryIds)) return null;
  if (body.equipmentRequirements !== undefined && !isEquipmentRequirements(body.equipmentRequirements)) return null;
  if (body.requiredQualificationIds !== undefined && !(hd && Array.isArray(body.requiredQualificationIds) && body.requiredQualificationIds.length === 0) && !isQualificationIds(body.requiredQualificationIds)) return null;
  if (body.requiredSkillIds !== undefined && !(hd && Array.isArray(body.requiredSkillIds) && body.requiredSkillIds.length === 0) && !isSkillIds(body.requiredSkillIds)) return null;
  return { id: typeof body.id === "string" ? body.id : "", name: canonicalWorkName(body.name), description: body.description.trim(), plannedDurationMinutes: body.plannedDurationMinutes, verificationMethodId: body.verificationMethodId, requiredSkills: body.requiredSkills, requiredQualifications: body.requiredQualifications,
    ...(typeof body.isEmergency === 'boolean' ? {isEmergency:body.isEmergency} : {}),
    ...(body.reportTemplate!==undefined ? {reportTemplate:parseReportTemplate(body.reportTemplate)!} : {}),
    ...(body.evidencePolicy!==undefined ? {evidencePolicy:parseEvidencePolicy(body.evidencePolicy)!} : {}),
    ...(body.categoryIds !== undefined ? { categoryIds: body.categoryIds as string[] } : {}),
    ...(body.equipmentRequirements !== undefined ? { equipmentRequirements: body.equipmentRequirements as EquipmentRequirement[] } : {}),
    ...(body.requiredQualificationIds !== undefined ? { requiredQualificationIds: body.requiredQualificationIds as string[] } : {}),
    ...(body.requiredSkillIds !== undefined ? { requiredSkillIds: body.requiredSkillIds as string[] } : {}) };
}

async function resolveReferences(database: D1Database, organizationId: string, payload: WorkTypeRecord, retainedIds: string[] = [], retainedSkillIds: string[] = []) {
  let connectionId: string | null = null;
  if (!["dispatcher", "automatic"].includes(payload.verificationMethodId)) {
    const connection = await database.prepare("SELECT id FROM ai_verifier_connections WHERE id = ? AND status = 'active' LIMIT 1").bind(payload.verificationMethodId).first<{ id: string }>();
    if (!connection) return null;
    connectionId = connection.id;
  }
  const skillIds = payload.categoryIds?.length && !payload.requiredSkillIds?.length && !payload.requiredSkills.length ? [] : await resolveSkillIds(database, organizationId, { ...(payload.requiredSkillIds ? { ids: payload.requiredSkillIds } : {}), names: payload.requiredSkills }, retainedSkillIds);
  const qualificationIds = payload.categoryIds?.length && !payload.requiredQualificationIds?.length && !payload.requiredQualifications.length ? [] : await resolveQualificationIds(database, organizationId, { ...(payload.requiredQualificationIds ? { ids: payload.requiredQualificationIds } : {}), names: payload.requiredQualifications }, retainedIds);
  if (!skillIds || !qualificationIds) return null;
  return { mode: connectionId ? "ai_model" : "dispatcher", autoAccept: Number(payload.verificationMethodId === "automatic"), connectionId, skillIds: skillIds as string[], qualificationIds: qualificationIds as string[] };
}
function isText(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0 && value.length <= 500; }
function isStringArray(value: unknown): value is string[] { return Array.isArray(value) && value.every((item) => typeof item === "string" && item.length <= 200); }
function isVerification(value: unknown): value is VerificationMethodId { return value === "automatic" || value === "dispatcher" || value === "route-vision-v1" || value === "quality-control-v2"; }

function catalogError(error: unknown) {
  if (error instanceof WorkCatalogError) return NextResponse.json({ message: error.message }, { status: error.status });
  if (String(error).includes("UNIQUE")) return NextResponse.json({ message: "Название или версия уже изменились. Обновите справочник." }, { status: 409 });
  return serverError(error);
}
