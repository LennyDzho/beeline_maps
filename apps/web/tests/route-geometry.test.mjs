import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {before,after,beforeEach,afterEach,test} from 'node:test';
import ts from 'typescript';
import {isolatedWorker} from './helpers/isolated-worker.mjs';
import {routeComparisonScenario} from './helpers/route-comparison.mjs';
const source=ts.transpileModule(await readFile(new URL('../app/lib/server/planning/previous-routes.ts',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
const {buildPreviousRoutes}=await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const row=(id,sequence,extra={})=>({id,number:id,work_name:'Работа',assignee_worker_id:'W',assignee_name:'Бригада',scheduled_start:'2026-08-20T12:00',scheduling_timezone:'Europe/Moscow',baseline_sequence:sequence,latitude:55+sequence/100,longitude:37,...extra});
const problem={id:'P',profile:{mode:'driving'},agents:[{id:'W',travelProfile:{mode:'cycling'},shifts:[{id:'S',startLocation:{lat:55,lon:37},window:{startAt:'2026-08-20T06:00:00Z',endAt:'2026-08-20T15:00:00Z'}}]}]};
test('GEOMETRY-01 baseline uses saved order and confirmed start/profile, with no invented return',async()=>{
  let query;
  const result=await buildPreviousRoutes([row('A',2),row('B',1)],problem,{providerId:'osrm',buildRoute:async q=>{query=q;return{data:[{geometry:q.stops.map(s=>s.point)}]};}});
  assert.deepEqual(result[0].visits.map(v=>v.jobId),['B','A']);assert.deepEqual(query.stops.map(s=>s.id),['start:W','B','A']);
  assert.equal(query.profile.mode,'cycling');assert.equal(query.departureAt,'2026-08-20T06:00:00Z');assert.equal(result[0].geometrySource,'osrm');
});
test('GEOMETRY-02 missing coordinates or unavailable worker retain the whole queue without partial geometry',async()=>{
  const adapter={buildRoute:()=>assert.fail('must not fabricate a partial route')};
  const missing=(await buildPreviousRoutes([row('A',1),row('B',2,{latitude:null})],problem,adapter))[0];
  assert.equal(missing.visits.length,2);assert.deepEqual(missing.geometry,[]);assert.match(missing.warning,/координаты/);
  const unavailable=(await buildPreviousRoutes([row('A',1)],{...problem,agents:[]},adapter))[0];
  assert.equal(unavailable.startPoint,null);assert.match(unavailable.warning,/доступность/);
  assert.deepEqual(await buildPreviousRoutes([row('A',1,{assignee_worker_id:null})],problem,adapter),[]);
});
test('GEOMETRY-03 service failure and empty response never appear as a road route',async()=>{
  for(const buildRoute of [async()=>{throw new Error('offline');},async()=>({data:[]})]) {
    const route=(await buildPreviousRoutes([row('A',1)],problem,{providerId:'osrm',buildRoute}))[0];
    assert.equal(route.geometrySource,'fallback');assert.deepEqual(route.geometry,[]);assert.match(route.warning,/не вернул маршрут/);
  }
});
let app;
before(async()=>{app=await isolatedWorker();});after(()=>app?.close());
beforeEach(()=>{app.db.exec('SAVEPOINT route_geometry');routeComparisonScenario(app);});afterEach(()=>app.db.exec('ROLLBACK TO route_geometry; RELEASE route_geometry'));
const calculate=async()=>(await app.json('/api/planning/group',{method:'POST',body:{serviceDate:'2026-08-20'}},201)).result;
test('GEOMETRY-04 common plan saves before/after order and geometry through publication and reload',async()=>{
  const plan=await calculate(),before=plan.previousRoutes.find(r=>r.agentId==='COMMON-1-W'),after=plan.routes.find(r=>r.agentId==='COMMON-1-W');
  assert.deepEqual(before.visits.map(v=>v.jobId),['ROUTE-SECOND','COMMON-1-J']);assert.deepEqual(after.visits.map(v=>v.jobId),['COMMON-1-J','ROUTE-SECOND']);
  assert.equal(before.geometrySource,'osrm');assert.notDeepEqual(before.geometry,after.geometry);
  assert.equal(plan.previousRoutes.some(r=>r.agentId==='COMMON-2-W'),false,'first assignment has no baseline');
  assert.deepEqual((await app.json('/api/planning/group?date=2026-08-20')).result.previousRoutes,plan.previousRoutes);
  await app.json('/api/planning/group',{method:'PUT',body:{planId:plan.planId}},200);
  assert.deepEqual((await app.json('/api/planning/group?date=2026-08-20')).result.previousRoutes,plan.previousRoutes);
});
test('GEOMETRY-05 former worker with no new route remains in the comparison',async()=>{
  app.db.exec("UPDATE workers SET active=0 WHERE id='COMMON-1-W'");
  const plan=await calculate(),before=plan.previousRoutes.find(r=>r.agentId==='COMMON-1-W');
  assert.equal(before.visits.length,2);assert.equal(before.geometrySource,'fallback');assert.match(before.warning,/доступность/);
  assert.equal(plan.routes.some(r=>r.agentId==='COMMON-1-W'),false);assert.equal(plan.changes.filter(c=>c.before.workerId==='COMMON-1-W'&&!c.after.workerId).length,2);
});
