export function commonScenario(app) {
  const db=app.db,now='2026-08-20T05:00:00.000Z';
  db.exec("UPDATE work_orders SET status='cancelled'; UPDATE workers SET active=0; DELETE FROM organization_planning_settings;");
  db.prepare("UPDATE system_settings SET optimization_engine='pyvrp',travel_matrix_provider='osrm',updated_at=? WHERE id=1").run(now);
  for(const [index,org] of ['ORG-001','ORG-002'].entries()) {
    const key=`COMMON-${index+1}`;
    db.prepare("UPDATE organizations SET timezone='Europe/Moscow' WHERE id=?").run(org);
    db.prepare("INSERT INTO organization_planning_settings(organization_id,optimization_engine,travel_matrix_provider,updated_at) VALUES (?,'local_greedy','osrm',?)").run(org,now);
    db.prepare("INSERT INTO work_schedules(id,organization_id,name,created_at,updated_at) VALUES (?,?,?,?,?)").run(`${key}-S`,org,'Общая смена',now,now);
    for(let day=1;day<=7;day++)db.prepare("INSERT INTO work_schedule_days(schedule_id,weekday,enabled,start_time,end_time) VALUES (?,?,1,'09:00','18:00')").run(`${key}-S`,day);
    db.prepare(`INSERT INTO workers(id,organization_id,work_schedule_id,employee_number,full_name,phone,timezone,start_address,start_latitude,start_longitude,shift_status,transport_mode,created_at,updated_at)
      VALUES (?,?,?,?,'Одинаковая бригада','','Europe/Moscow','Москва, Офис',55.75,37.61,'on_shift','car',?,?)`).run(`${key}-W`,org,`${key}-S`,key,now,now);
    if(index===0) {
      db.prepare("INSERT INTO work_types(id,organization_id,code,name,created_at,updated_at) VALUES (?,?,?,?,?,?)").run(`${key}-T`,org,key,'Общая работа',now,now);
      db.prepare("INSERT INTO work_type_versions(id,work_type_id,version,status,planned_duration_minutes,created_at) VALUES (?,?,1,'published',60,?)").run(`${key}-V`,`${key}-T`,now);
    }
    db.prepare(`INSERT INTO work_orders(id,organization_id,number,work_type_version_id,created_by_user_id,status,scheduled_start,scheduled_end,scheduling_timezone,client_window_start,client_window_end,address_snapshot,latitude_snapshot,longitude_snapshot,created_at,updated_at)
      VALUES (?,?,?,?,'QA-ADMIN','new','2026-08-20T12:00','2026-08-20T13:00','Europe/Moscow','2026-08-20T06:00:00.000Z','2026-08-20T14:00:00.000Z','Москва, Тестовый дом',55.76,37.62,?,?)`).run(`${key}-J`,org,key,'COMMON-1-V',now,now);
  }
  return {date:'2026-08-20',jobIds:['COMMON-1-J','COMMON-2-J'],workerIds:['COMMON-1-W','COMMON-2-W']};
}
