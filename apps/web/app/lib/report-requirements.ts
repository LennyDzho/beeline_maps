export type ReportField = { id: string; label: string; required: boolean };
export type ReportTemplate = { fields: ReportField[] };
export type EvidencePolicy = { minPhotos: number; minVideos: number };
export type ReportSection = {
  versionId: string; name: string; fields: ReportField[]; minPhotos: number; minVideos: number;
  verificationMode: string; verifierId: string | null; configurationError?: string;
};
export type ReportSectionResult = ReportSection & { values: Record<string,string> };

const object = (value: unknown): value is Record<string,unknown> => Boolean(value) && typeof value==='object' && !Array.isArray(value);
export function parseReportTemplate(value: unknown): ReportTemplate | null {
  if (!object(value) || Object.keys(value).some(key=>key!=='fields')) return null;
  const fields=value.fields ?? [];
  if (!Array.isArray(fields) || fields.length>20 || !fields.every(field=>object(field)
    && Object.keys(field).every(key=>['id','label','required'].includes(key))
    && typeof field.id==='string' && /^[A-Za-z0-9_-]{1,64}$/u.test(field.id)
    && typeof field.label==='string' && field.label.trim().length>0 && field.label.length<=150 && typeof field.required==='boolean')) return null;
  if (new Set(fields.map(field=>field.id)).size!==fields.length) return null;
  return {fields:fields.map(field=>({id:field.id,label:field.label.trim(),required:field.required}))};
}
export function parseEvidencePolicy(value: unknown): EvidencePolicy | null {
  if (!object(value) || Object.keys(value).some(key=>!['minPhotos','minVideos'].includes(key))) return null;
  const minPhotos=value.minPhotos ?? 0,minVideos=value.minVideos ?? 0;
  if (!Number.isInteger(minPhotos) || !Number.isInteger(minVideos) || Number(minPhotos)<0 || Number(minVideos)<0 || Number(minPhotos)+Number(minVideos)>8) return null;
  return {minPhotos:Number(minPhotos),minVideos:Number(minVideos)};
}
function json(value: string): unknown { try {return JSON.parse(value);} catch {return null;} }

export async function loadReportRequirements(database: D1Database, organizationId: string, orderIds: string[]) {
  const result=new Map<string,ReportSection[]>();
  if (!orderIds.length) return result;
  const rows=await database.prepare(`SELECT o.id AS order_id,v.id AS version_id,COALESCE(c.name_snapshot,t.name) AS name,
      v.report_template_json,v.evidence_policy_json,v.verification_mode,v.auto_accept_report,v.ai_verifier_connection_id
    FROM work_orders o LEFT JOIN work_order_work_types c ON c.work_order_id=o.id
    JOIN work_type_versions v ON v.id=COALESCE(c.work_type_version_id,o.work_type_version_id)
    JOIN work_types t ON t.id=v.work_type_id
    WHERE o.organization_id=? AND o.id IN (SELECT value FROM json_each(?)) ORDER BY o.id,c.sequence,v.id`)
    .bind(organizationId,JSON.stringify(orderIds)).all<{order_id:string;version_id:string;name:string;report_template_json:string;evidence_policy_json:string;verification_mode:string;auto_accept_report:number;ai_verifier_connection_id:string|null}>();
  for (const row of rows.results) {
    const template=parseReportTemplate(json(row.report_template_json)),policy=parseEvidencePolicy(json(row.evidence_policy_json));
    const section:ReportSection={versionId:row.version_id,name:row.name,fields:template?.fields ?? [],minPhotos:policy?.minPhotos ?? 0,minVideos:policy?.minVideos ?? 0,
      verificationMode:row.auto_accept_report ? "automatic" : row.verification_mode,verifierId:row.ai_verifier_connection_id,
      ...(!template || !policy ? {configurationError:'Не поддерживается сохранённый шаблон отчёта. Обратитесь к диспетчеру.'} : {})};
    result.set(row.order_id,[...(result.get(row.order_id) ?? []),section]);
  }
  return result;
}

/** All saved HD versions apply. Shared visit evidence must satisfy each policy;
 * same-named fields are kept separate under their version IDs. */
export function validateReportSections(sections: ReportSection[], input: unknown, media: readonly {kind:string}[]): ReportSectionResult[] {
  const values=input ?? {};
  if (JSON.stringify(values).length>12000) throw new Error('Сократите поля отчёта: общий объём — не более 12000 символов.');
  if (!object(values) || Object.keys(values).some(id=>!sections.some(section=>section.versionId===id))) throw new Error('Обновите форму отчёта: состав работ изменился.');
  return sections.map(section=>{
    if (section.configurationError) throw new Error(`${section.name}: ${section.configurationError}`);
    const fields=Object.hasOwn(values,section.versionId) ? values[section.versionId] : {};
    if (!object(fields) || Object.keys(fields).some(id=>!section.fields.some(field=>field.id===id))) throw new Error(`${section.name}: неизвестное поле отчёта.`);
    const normalized:Record<string,string>={};
    for (const field of section.fields) {
      const value=Object.hasOwn(fields,field.id) ? fields[field.id] : '';
      if (typeof value!=='string' || value.length>2000) throw new Error(`${section.name} — ${field.label}: не более 2000 символов.`);
      if (field.required && !value.trim()) throw new Error(`${section.name}: заполните «${field.label}».`);
      Object.defineProperty(normalized,field.id,{value:value.trim(),enumerable:true});
    }
    if (media.filter(item=>item.kind==='photo').length<section.minPhotos || media.filter(item=>item.kind==='video').length<section.minVideos)
      throw new Error(`${section.name}: требуется фото — ${section.minPhotos}, видео — ${section.minVideos}.`);
    return {...section,values:normalized};
  });
}

export function readReportSections(value: string): ReportSectionResult[] {
  const saved=json(value);
  return object(saved) && saved.schema===1 && Array.isArray(saved.sections) ? saved.sections as ReportSectionResult[] : [];
}
