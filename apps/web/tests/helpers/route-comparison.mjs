import {commonScenario} from './common-plan.mjs';
export function routeComparisonScenario(app) {
  commonScenario(app);
  app.db.exec(`UPDATE work_orders SET status='assigned',assignee_worker_id='COMMON-1-W',scheduled_start='2026-08-20T16:00',scheduled_end='2026-08-20T17:00',client_window_end='2026-08-20T07:00:00.000Z' WHERE id='COMMON-1-J';
    INSERT INTO work_orders(id,organization_id,number,work_type_version_id,created_by_user_id,status,assignee_worker_id,scheduled_start,scheduled_end,scheduling_timezone,client_window_start,client_window_end,address_snapshot,latitude_snapshot,longitude_snapshot,created_at,updated_at)
      SELECT 'ROUTE-SECOND',organization_id,'SECOND',work_type_version_id,created_by_user_id,status,assignee_worker_id,'2026-08-20T12:00','2026-08-20T13:00',scheduling_timezone,'2026-08-20T09:00:00.000Z','2026-08-20T14:00:00.000Z',address_snapshot,55.78,37.64,created_at,updated_at FROM work_orders WHERE id='COMMON-1-J';`);
}
