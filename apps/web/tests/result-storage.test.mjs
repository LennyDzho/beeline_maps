import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import ts from 'typescript';
import {isolatedWorker} from './helpers/isolated-worker.mjs';
import {commonScenario} from './helpers/common-plan.mjs';
const source=ts.transpileModule(await readFile(new URL('../app/lib/server/planning/result-storage.ts',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
const {serializePlanningResult,deserializePlanningResult}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
const geometry=Array.from({length:100_000},(_,i)=>({lat:55.75+i/1e7,lon:37.6+i/1e7}));

test('STORAGE-01 large route history is compressed without rounding coordinates or changing Russian text',async()=>{
  const result={planId:'P',routes:[{geometry}],previousRoutes:[{geometry}],changes:[{reason:'Заявка перенесена с бригады'}]};
  const raw=JSON.stringify(result),packed=await serializePlanningResult(result);
  assert.ok(Buffer.byteLength(raw)>2_000_000);assert.ok(Buffer.byteLength(packed)<1_800_000);
  assert.ok(Buffer.byteLength(packed)<Buffer.byteLength(raw)/3);
  assert.deepEqual(await deserializePlanningResult(packed),result);
  assert.deepEqual(await deserializePlanningResult(raw),result);
});

test('STORAGE-02 a large legacy common draft is compacted during atomic publication and reload keeps its complete geometry',async()=>{
  const app=await isolatedWorker();
  try {
    const f=commonScenario(app);
    const result=(await app.json('/api/planning/group',{method:'POST',body:{serviceDate:f.date}},201)).result;
    result.routes[0].geometry=geometry;
    app.db.prepare('UPDATE route_plan_groups SET result_json=? WHERE id=?').run(JSON.stringify(result),result.planId);
    await app.json('/api/planning/group',{method:'PUT',body:{planId:result.planId}});
    const stored=app.db.prepare('SELECT status,length(CAST(result_json AS BLOB)) AS bytes FROM route_plan_groups WHERE id=?').get(result.planId);
    assert.equal(stored.status,'published');assert.ok(stored.bytes<1_000_000);
    const reloaded=(await app.json(`/api/planning/group?date=${f.date}`)).result;
    assert.deepEqual(reloaded.routes[0].geometry,geometry);assert.equal(reloaded.metrics.plannedJobs,2);
    assert.equal(reloaded.status,'published');
  }finally{app.close();}
});
