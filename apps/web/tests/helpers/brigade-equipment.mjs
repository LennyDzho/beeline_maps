export async function equipmentScenario(app) {
  app.db.exec("UPDATE work_orders SET status='cancelled'; UPDATE workers SET active=0 WHERE id<>'EMP-402'");
  await app.json('/api/admin/settings',{method:'PUT',body:{appName:'Марш!',timezone:'Europe/Moscow',emailAlerts:true,weeklyDigest:false,optimizationEngine:'pyvrp',travelMatrixProvider:'osrm'}});
  const worker=(await app.json('/api/engineers')).items.find(w=>w.id==='EMP-402');
  const {item:bk}=await app.json('/api/admin/work-categories',{method:'POST',body:{name:'Оснащение',description:'',active:true}},201);
  const equipment=[],types=[];
  for(const name of ['Тестер','Лестница']) {
    const {item}=await app.json('/api/admin/equipment',{method:'POST',body:{name,unit:'шт',usage:'reusable',active:true}},201);equipment.push(item);
    types.push((await app.json('/api/admin/work-types',{method:'POST',body:{name:`Работа: ${name}`,categoryIds:[bk.id],description:'',plannedDurationMinutes:30,verificationMethodId:'dispatcher',
      requiredSkills:[],requiredQualifications:[],requiredSkillIds:[],requiredQualificationIds:[],equipmentRequirements:[{equipmentId:item.id,quantity:null}]}},201)).item);
  }
  await app.json('/api/engineers',{method:'PUT',body:{...worker,workCompetencies:types.map(type=>({categoryId:bk.id,workTypeId:type.id}))}});
  const date='2026-08-20';
  const create=async(index,assigned=false)=>(await app.json('/api/requests',{method:'POST',body:{categoryId:bk.id,work:types[index].name,workTypeIds:[types[index].id],description:'Проверка комплекта',
    priority:'medium',status:assigned?'assigned':'new',dateTime:`${date}T${index?'12':'09'}:00`,clientWindowStart:`${date}T09:00`,clientWindowEnd:`${date}T17:00`,
    address:'Москва, Тестовая, 1',assignee:assigned?worker.name:'',assigneeId:assigned?worker.id:''}},201)).item;
  const read=()=>app.json(`/api/engineers/equipment?workerId=${worker.id}&date=${date}`);
  const issue=async ids=>{const state=await read();return app.json('/api/engineers/equipment',{method:'PUT',body:{workerId:worker.id,date,revision:state.revision,equipmentIds:ids,reason:'Фактически полученный комплект'}});};
  return {worker,equipment,types,date,create,read,issue};
}
