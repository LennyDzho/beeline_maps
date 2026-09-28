import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
import test from 'node:test';

test('optimizer upgrade preserves settings, replaces the retired choice and rejects it afterwards',async()=>{
  const previous=await readFile(new URL('../drizzle/0029_pyvrp_optimizer.sql',import.meta.url),'utf8');
  const upgrade=await readFile(new URL('../drizzle/0030_supported_optimizers.sql',import.meta.url),'utf8');
  for(const engine of ['local_greedy','pyvrp','ortools','two_gis_tsp']) {
    const db=new DatabaseSync(':memory:');
    try {
      db.exec(previous.split('--> statement-breakpoint')[0].replace('system_settings_next','system_settings'));
      const matrix=engine==='two_gis_tsp'?'two_gis':'osrm';
      db.prepare("INSERT INTO system_settings(id,optimization_engine,travel_matrix_provider,solver_policy,calculation_timeout_seconds,updated_at) VALUES (1,?,?, 'emergency_staff/v1',420,'2026-09-01')").run(engine,matrix);
      db.exec(upgrade);
      const row=db.prepare('SELECT * FROM system_settings').get();
      assert.equal(row.optimization_engine,engine==='local_greedy'?'pyvrp':engine);
      assert.equal(row.travel_matrix_provider,matrix);assert.equal(row.solver_policy,'emergency_staff/v1');assert.equal(row.calculation_timeout_seconds,420);
      if(engine==='local_greedy')assert.notEqual(row.updated_at,'2026-09-01','retired-method drafts become stale');
      else assert.equal(row.updated_at,'2026-09-01','other solver selections retain their revision');
      assert.throws(()=>db.exec("UPDATE system_settings SET optimization_engine='local_greedy'"),/CHECK/);
    } finally { db.close(); }
  }
});
