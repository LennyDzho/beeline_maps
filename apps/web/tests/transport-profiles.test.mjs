import assert from "node:assert/strict";
import {before,after,beforeEach,afterEach,test} from "node:test";
import {isolatedWorker} from "./helpers/isolated-worker.mjs";

let app;
before(async()=>{app=await isolatedWorker();});
after(()=>app?.close());
beforeEach(()=>app.db.exec("SAVEPOINT transport_case"));
afterEach(()=>{app.twoGisHandler=null;app.db.exec("ROLLBACK TO transport_case; RELEASE transport_case");});

async function prepare() {
  app.db.exec("UPDATE work_orders SET status='cancelled'; UPDATE workers SET active=0 WHERE id<>'EMP-402'; UPDATE resources SET assigned_worker_id=NULL,status='available',condition='serviceable'");
  await app.json('/api/requests',{method:'POST',body:{work:'Ремонт оборудования',description:'Транспорт по ресурсу',priority:'medium',status:'new',dateTime:'2026-08-20T10:00',address:'Москва, Тестовая, 1',assignee:'',clientWindowStart:'2026-08-20T09:00',clientWindowEnd:'2026-08-20T17:00'}},201);
  return (await app.json('/api/engineers')).items.find(w=>w.id==='EMP-402');
}
async function settings(provider) {
  await app.json('/api/admin/settings',{method:'PUT',body:{scope:'planning',optimizationEngine:'pyvrp',travelMatrixProvider:provider}});
}
async function plan() {
  app.calls.length=0;
  const {result}=await app.json('/api/planning',{method:'POST',body:{serviceDate:'2026-08-20'}},201);
  assert.equal(result.metrics.plannedJobs,1);
  assert.ok(result.routes[0].geometry.length>=2);
  return result;
}

test('TRAVEL-01 OSRM uses only driving for assigned and unassigned brigades, ignoring legacy modes',async()=>{
  let worker=await prepare();
  await settings('osrm');
  for (const legacy of ['walking','cycling','car']) {
    app.db.prepare("UPDATE workers SET travel_mode=? WHERE id='EMP-402'").run(legacy);
    worker=(await app.json('/api/engineers')).items.find(w=>w.id==='EMP-402');
    assert.equal(worker.transportType,'transit');
    const result=await plan();
    assert.equal(result.routes[0].transportMode,'driving');
    assert.match(result.routes[0].vehicle,/Общественный транспорт/);
    assert.ok(app.calls.some(url=>url.includes('/table/v1/driving/')));
    assert.ok(app.calls.some(url=>url.includes('/route/v1/driving/')));
    assert.ok(!app.calls.some(url=>/foot|bike|public_transport|2gis/.test(url)));
  }
  const vehicle=(await app.json('/api/engineers')).vehicles[0];
  // Conflicting client-side mode must not override the resource assignment.
  worker=(await app.json('/api/engineers',{method:'PUT',body:{...worker,transportType:'transit',resourceId:vehicle.id}})).item;
  assert.equal(worker.transportType,'car');
  assert.equal(worker.transport,vehicle.plate);
  const result=await plan();
  assert.equal(result.routes[0].transportMode,'driving');
  assert.match(result.routes[0].vehicle,/Автомобиль/);
  // Release through Resources, independently of the engineer editor.
  const resource=(await app.json('/api/resources')).items.find(v=>v.id===vehicle.id);
  await app.json('/api/resources',{method:'PUT',body:{...resource,assignment:''}});
  assert.equal((await app.json('/api/engineers')).items.find(w=>w.id===worker.id).transportType,'transit');
  assert.match((await app.json('/api/requests')).engineers.find(w=>w.id===worker.id).vehicle,/Общественный транспорт/);
  await app.json('/api/planning',{method:'PUT',body:{planId:result.planId}},409);
  for (const transportType of ['none','cycling']) await app.json('/api/engineers',{method:'PUT',body:{...worker,transportType}},400);
});

test('TRAVEL-02 2GIS uses transit with walking geometry without a car, driving with a resource assigned through Resources',async()=>{
  const worker=await prepare();
  const bodies=[];
  app.twoGisHandler=(url,body)=>{
    bodies.push({path:url.pathname,body});
    if(url.pathname==='/get_dist_matrix') return Response.json({routes:body.sources.flatMap(s=>body.targets.map(t=>({source_id:s,target_id:t,status:'OK',duration:s===t?0:300,distance:s===t?0:1000})))});
    const geometry={selection:'LINESTRING(37.60 55.75,37.61 55.76)'};
    if(url.pathname==='/public_transport/2.0') return Response.json([{total_duration:300,total_distance:1000,movements:[{alternatives:[{geometry}]}]}]);
    if(url.pathname==='/routing/7.0.0/global') return Response.json({status:'OK',result:[{total_duration:300,total_distance:1000,maneuvers:[{outcoming_path:geometry}]}]});
    throw new Error(`Unexpected 2GIS endpoint ${url.pathname}`);
  };
  await settings('two_gis');
  const transit=await plan();
  assert.equal(transit.routes[0].transportMode,'public_transport');
  assert.equal(transit.routes[0].geometrySource,'2gis');
  assert.ok(bodies.filter(b=>b.path==='/get_dist_matrix').every(b=>b.body.transport==='public_transport'));
  assert.ok(bodies.some(b=>b.path==='/public_transport/2.0' && b.body.enable_schedule===true));
  assert.ok(!app.calls.some(url=>/osrm|\/routing\//.test(url)));
  const resource=(await app.json('/api/resources')).items[0];
  await app.json('/api/resources',{method:'PUT',body:{...resource,assignment:worker.name}});
  assert.equal((await app.json('/api/engineers')).items.find(w=>w.id===worker.id).transportType,'car');
  bodies.length=0;
  const car=await plan();
  assert.equal(car.routes[0].transportMode,'driving');
  assert.equal(car.routes[0].geometrySource,'2gis');
  assert.ok(bodies.filter(b=>b.path==='/get_dist_matrix').every(b=>b.body.transport==='driving'));
  assert.ok(bodies.some(b=>b.path==='/routing/7.0.0/global'));
  assert.ok(!app.calls.some(url=>url.includes('public_transport')));
});
