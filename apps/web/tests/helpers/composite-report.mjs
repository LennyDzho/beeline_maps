import {commonScenario} from './common-plan.mjs';
export async function compositeReportScenario(app, verificationMethods = ['dispatcher', 'dispatcher']) {
  commonScenario(app);
  app.db.exec("UPDATE work_orders SET status='cancelled' WHERE id='COMMON-1-J'; UPDATE workers SET user_id=NULL WHERE user_id='USR-402'; UPDATE workers SET user_id='USR-402' WHERE id='COMMON-1-W'");
  const category=(await app.json('/api/admin/work-categories',{method:'POST',body:{name:'Отчётные работы',description:'',active:true}},201)).item;
  const types=[];
  for(const [i,name] of ['Проверка линии','Настройка роутера'].entries()) types.push((await app.json('/api/admin/work-types',{method:'POST',body:{
    name,description:'',categoryIds:[category.id],plannedDurationMinutes:30,verificationMethodId:verificationMethods[i],requiredSkills:[],requiredQualifications:[],
    reportTemplate:{fields:[{id:'result',label:i ? 'Серийный номер' : 'Уровень сигнала',required:true}]},
    evidencePolicy:{minPhotos:i ? 0 : 1,minVideos:i ? 1 : 0},
  }},201)).item);
  const worker=(await app.json('/api/engineers')).items.find(item=>item.id==='COMMON-1-W');
  await app.json('/api/engineers',{method:'PUT',body:{...worker,skill:'',clearance:'',skillIds:[],qualificationIds:[],workCompetencies:types.map(type=>({categoryId:category.id,workTypeId:type.id}))}});
  const order=(await app.json('/api/requests',{method:'POST',body:{categoryId:category.id,workTypeIds:types.map(type=>type.id),work:types.map(type=>type.name).join(' + '),
    serviceDurationMinutes:60,durationSource:'Общий выезд',description:'Составной отчёт',priority:'medium',status:'new',dateTime:'2026-08-20T10:00',
    clientWindowStart:'2026-08-20T09:00',clientWindowEnd:'2026-08-20T14:00',address:'Москва, Тестовая улица, 1',assignee:''}},201)).item;
  app.db.exec("UPDATE users SET password_salt=(SELECT password_salt FROM users WHERE id='QA-ADMIN'),password_hash=(SELECT password_hash FROM users WHERE id='QA-ADMIN'),password_iterations=1000,must_change_password=0 WHERE id='USR-402'");
  const email=app.db.prepare("SELECT email FROM users WHERE id='USR-402'").get().email;
  const {token}=await app.json('/api/mobile/v1/auth/login',{method:'POST',body:{email,password:'isolated-test-password'}});
  return {category,types,order,headers:{authorization:`Bearer ${token}`}};
}
