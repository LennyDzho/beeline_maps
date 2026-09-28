import assert from 'node:assert/strict';
import {before,after,beforeEach,afterEach,test} from 'node:test';
import {isolatedWorker} from './helpers/isolated-worker.mjs';
let app;
before(async()=>{app=await isolatedWorker();});
after(()=>app?.close());
beforeEach(()=>app.db.exec('SAVEPOINT catalog_vehicles'));
afterEach(()=>app.db.exec('ROLLBACK TO catalog_vehicles; RELEASE catalog_vehicles'));

test('VK equipment is applied once, explicit empty list clears new requirements, old snapshots survive edits',async()=>{
 const equipment=(await app.json('/api/admin/equipment',{method:'POST',body:{name:'Тестовый комплект',unit:'шт',usage:'consumable',active:true}},201)).item;
 const category=(await app.json('/api/admin/work-categories',{method:'POST',body:{name:'Подключение',description:'',active:true,serviceDurationMinutes:70,equipment:[{equipmentId:equipment.id,quantity:1}]}},201)).item;
 const types=[];
 for(const name of ['HD один','HD два']) types.push((await app.json('/api/admin/work-types',{method:'POST',body:{name,description:'',categoryIds:[category.id],plannedDurationMinutes:70,verificationMethodId:'automatic',requiredSkills:[],requiredQualifications:[],equipmentRequirements:[{equipmentId:equipment.id,quantity:4}]}},201)).item);
 const body={categoryId:category.id,workTypeIds:types.map(t=>t.id),work:types.map(t=>t.name).join(' + '),description:'',priority:'medium',status:'new',dateTime:'2026-08-18T10:00',address:'Москва, Тестовая, 1',assignee:''};
 const first=(await app.json('/api/requests',{method:'POST',body},201)).item;
 assert.equal(first.equipment.length,1); assert.equal(first.equipment[0].quantity,1);
 await app.json('/api/admin/work-categories',{method:'PUT',body:{...category,equipment:[{equipmentId:'missing',quantity:1}]}},400);
 assert.equal((await app.json('/api/admin/work-categories')).items.find(c=>c.id===category.id).equipment[0].quantity,1);
 await app.json('/api/admin/work-categories',{method:'PUT',body:{...category,equipment:[]}});
 const second=(await app.json('/api/requests',{method:'POST',body},201)).item;
 assert.deepEqual(second.equipment,[]);
 const saved=(await app.json('/api/requests',{method:'PUT',body:{...first,description:'Только описание'}})).item;
 assert.deepEqual(saved.equipment,first.equipment);
});

test('numeric employee number and exclusive resource binding: claim, reject, change, release and foreign division',async()=>{
 const payload=await app.json('/api/engineers'); const [a,b]=payload.items;
 app.db.exec("UPDATE resources SET assigned_worker_id=NULL,status='available',condition='serviceable'");
 const vehicles=(await app.json('/api/engineers')).vehicles; assert.ok(vehicles.length>=2);
 const save=(worker,resourceId,extra={})=>app.json('/api/engineers',{method:'PUT',body:{...worker,transportType:'car',resourceId,...extra}});
 const a1=(await save(a,vehicles[0].id)).item;
 assert.equal(a1.resourceId,vehicles[0].id); assert.equal(a1.transport,vehicles[0].plate);
 await app.json('/api/engineers',{method:'PUT',body:{...b,transportType:'car',resourceId:vehicles[0].id,name:'НЕ СОХРАНЯТЬ'}},409);
 assert.equal(app.db.prepare('SELECT full_name FROM workers WHERE id=?').get(b.id).full_name,b.name);
 await save(a1,vehicles[1].id);
 assert.equal(app.db.prepare('SELECT assigned_worker_id FROM resources WHERE id=?').get(vehicles[0].id).assigned_worker_id,null);
 await save(b,vehicles[0].id);
 await save(a1,'',{transportType:'transit'});
 assert.equal(app.db.prepare('SELECT assigned_worker_id FROM resources WHERE id=?').get(vehicles[1].id).assigned_worker_id,null);
 app.db.prepare("UPDATE resources SET organization_id='ORG-002' WHERE id=?").run(vehicles[1].id);
 await app.json('/api/engineers',{method:'PUT',body:{...a,transportType:'car',resourceId:vehicles[1].id}},409);
 const created=(await app.json('/api/engineers',{method:'POST',body:{...a,id:'',name:'Новая бригада',userId:'',workCompetencies:[],skillIds:[],qualificationIds:[],skill:'',clearance:'',section:'',transportType:'transit',resourceId:''}},201)).item;
 assert.match(created.employeeNumber,/^\d+$/); assert.notEqual(created.id,created.employeeNumber);
});

test('a vehicle claimed between validation and transaction rolls back the whole worker edit',async()=>{
 const [a,b]=(await app.json('/api/engineers')).items;
 app.db.exec("UPDATE resources SET assigned_worker_id=NULL,status='available',condition='serviceable'");
 const v=(await app.json('/api/engineers')).vehicles[0];
 // SQLite trigger simulates a competing claim after the initial read, before the guard.
 app.db.exec(`CREATE TRIGGER competing_claim AFTER UPDATE ON workers WHEN NEW.id='${a.id}' BEGIN UPDATE resources SET assigned_worker_id='${b.id}' WHERE id='${v.id}'; END`);
 await app.json('/api/engineers',{method:'PUT',body:{...a,name:'Не сохранять при конфликте',transportType:'car',resourceId:v.id}},409);
 assert.equal(app.db.prepare('SELECT full_name FROM workers WHERE id=?').get(a.id).full_name,a.name);
 assert.equal(app.db.prepare('SELECT assigned_worker_id FROM resources WHERE id=?').get(v.id).assigned_worker_id,null);
});
