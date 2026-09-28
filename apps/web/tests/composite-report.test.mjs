import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {before,after,beforeEach,afterEach,test} from 'node:test';
import {createHash} from 'node:crypto';
import ts from 'typescript';
import {isolatedWorker} from './helpers/isolated-worker.mjs';
import {compositeReportScenario} from './helpers/composite-report.mjs';
const source=ts.transpileModule(await readFile(new URL('../app/lib/report-requirements.ts',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
const {parseReportTemplate,parseEvidencePolicy,validateReportSections}=await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
test('REPORT-HD-01 validates supported templates and policies without silently dropping unknown requirements',()=>{
  assert.deepEqual(parseReportTemplate({}),{fields:[]});assert.equal(parseReportTemplate({fields:[{id:'x',label:'A',required:true},{id:'x',label:'B',required:true}]}),null);
  assert.equal(parseReportTemplate({unknownRequirement:true}),null);assert.equal(parseEvidencePolicy({minPhotos:8,minVideos:1}),null);
  assert.throws(()=>validateReportSections([{versionId:'V',name:'HD',fields:[],configurationError:'Unsupported'}],{},[]),/Unsupported/);
});
let app;
before(async()=>{app=await isolatedWorker();});after(()=>app?.close());
beforeEach(()=>app.db.exec('SAVEPOINT report_hd'));afterEach(()=>app.db.exec('ROLLBACK TO report_hd; RELEASE report_hd'));
test('REPORT-HD-02 edits preserve omitted templates and existing composite visits retain every saved HD version',async()=>{
  const f=await compositeReportScenario(app),original=f.types[0];
  const {reportTemplate,evidencePolicy,...legacy}=original;
  const edited=(await app.json('/api/admin/work-types',{method:'PUT',body:{...legacy,description:'Редактирование старым клиентом'}})).item;
  assert.deepEqual(edited.reportTemplate,reportTemplate);assert.deepEqual(edited.evidencePolicy,evidencePolicy);
  await app.json('/api/admin/work-types',{method:'PUT',body:{...edited,reportTemplate:{fields:[{id:'new',label:'Новое поле',required:true}]}}});
  const plan=(await app.json('/api/planning/group',{method:'POST',body:{serviceDate:'2026-08-20'}},201)).result;
  await app.json('/api/planning/group',{method:'PUT',body:{planId:plan.planId}});
  const visit=(await app.json('/api/mobile/v1/state?date=2026-08-20',{headers:f.headers,cookie:''})).visits.find(v=>v.id===f.order.id);
  assert.deepEqual(visit.reportRequirements.map(s=>s.versionId),f.types.map(t=>t.versionId));
  assert.deepEqual(visit.reportRequirements.map(s=>s.fields[0].id),['result','result']);assert.equal(visit.reportRequirements[1].minVideos,1);
});
for (const modes of [['dispatcher','dispatcher'], ['automatic','automatic'], ['automatic','dispatcher']]) test(`REPORT-HD-03 ${modes.join('+')}: plan → mobile FSM → validation → acceptance is atomic and repeatable`,async()=>{
  const automatic=modes.every(mode=>mode==='automatic');
  const f=await compositeReportScenario(app,modes),id=f.order.id,headers=f.headers;
  assert.deepEqual(f.types.map(type=>type.verificationMethodId),modes);
  // A subsequent catalog edit never changes the verification policy pinned to this visit.
  await app.json('/api/admin/work-types',{method:'PUT',body:{...f.types[0],verificationMethodId:modes[0]==='automatic'?'dispatcher':'automatic'}});
  const plan=(await app.json('/api/planning/group',{method:'POST',body:{serviceDate:'2026-08-20'}},201)).result;
  await app.json('/api/planning/group',{method:'PUT',body:{planId:plan.planId}});
  const state=async()=>(await app.json('/api/mobile/v1/state?date=2026-08-20',{headers,cookie:''})).visits.find(v=>v.id===id);
  const command=async(body,status=200)=>app.json('/api/mobile/v1/commands',{method:'POST',headers,cookie:'',body:{operationId:crypto.randomUUID(),action:'status',visitId:id,revision:(await state()).revision,...body}},status);
  await command({status:'en_route'});await command({status:'in_progress'});
  const stock=app.db.prepare("SELECT * FROM worker_day_equipment WHERE worker_id='COMMON-1-W'").get();assert.ok(stock);
  const env=globalThis[Symbol.for('mmi.test.cloudflare.env')],oldMedia=env.MEDIA,oldStream=globalThis.FixedLengthStream,objects=new Map();
  env.MEDIA={put:async(key,stream)=>{objects.set(key,new Uint8Array(await new Response(stream).arrayBuffer()));}};
  globalThis.FixedLengthStream=class extends TransformStream {constructor(){super();}};
  const media=[];
  try {
    for(const mime of ['image/png','video/mp4']) {
      const bytes=mime==='image/png' ? new Uint8Array([137,80,78,71,13,10,26,10,0,0,0,0,0,0,0,0]) : new Uint8Array([0,0,0,16,102,116,121,112,105,115,111,109,0,0,0,0]);
      const mediaId=crypto.randomUUID();media.push(mediaId);
      const response=await app.handle(new Request(`http://isolated.test/api/mobile/v1/media/${id}/${mediaId}`,{method:'PUT',headers:{...headers,'content-type':mime,'content-length':String(bytes.length),'x-content-sha256':createHash('sha256').update(bytes).digest('hex'),'x-file-name':encodeURIComponent(mime==='image/png'?'result.png':'result.mp4')},body:bytes}));
      assert.equal(response.status,200,await response.text());
    }
  } finally {env.MEDIA=oldMedia;globalThis.FixedLengthStream=oldStream;}
  assert.equal(objects.size,2,'isolated upload pipeline stores both files');
  const report='Обе работы выполнены, результат проверен.';
  const firstOnly={[f.types[0].versionId]:{result:'-18 dBm'}};
  const missing=await command({status:'completed',report,mediaIds:media,reportValues:firstOnly},400);assert.match(missing.message,/Серийный номер/);
  const values={...firstOnly,[f.types[1].versionId]:{result:'SN-123'}};
  assert.match((await command({status:'completed',report,mediaIds:media.slice(0,1),reportValues:values},400)).message,/видео — 1/);
  assert.equal((await state()).status,'in_progress');assert.equal(app.db.prepare('SELECT status FROM work_reports WHERE work_order_id=?').get(id).status,'draft');
  const complete={operationId:crypto.randomUUID(),status:'completed',report,mediaIds:media,reportValues:values,revision:(await state()).revision};
  await command(complete);assert.equal((await command(complete)).replayed,true);
  const mobile=await state();assert.equal(mobile.status,automatic?'confirmed':'completed');assert.deepEqual(mobile.reportValues,values);
  const saved=(await app.json('/api/requests')).items.find(item=>item.id===id);assert.equal(saved.completionReport.sections.length,2);
  assert.equal(saved.completionReport.sections[1].values.result,'SN-123');
  if (automatic) {
    assert.deepEqual(saved.completionReport.sections.map(s=>s.verificationMode),modes);
    const accepted=app.db.prepare("SELECT * FROM work_order_status_history WHERE work_order_id=? AND to_status='confirmed'").all(id);
    assert.equal(accepted.length,1);assert.equal(accepted[0].changed_by_user_id,null);assert.match(accepted[0].reason,/автоматически/);
    assert.ok(app.db.prepare('SELECT accepted_at FROM work_reports WHERE work_order_id=?').get(id).accepted_at);
  } else {
    assert.equal(mobile.reportStatus,'submitted');
    await app.json('/api/requests',{method:'PUT',body:{...saved,status:'confirmed'}});
  }
  assert.equal((await state()).reportStatus,'accepted');assert.equal(app.db.prepare('SELECT COUNT(*) n FROM report_reviews WHERE report_id=(SELECT id FROM work_reports WHERE work_order_id=?)').get(id).n,automatic?0:1);
});
