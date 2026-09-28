// Disposable device acceptance host: no on-disk DB, user credentials or real R2.
import {writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {startBrowserServer} from './browser-server.mjs';
import {compositeReportScenario} from './composite-report.mjs';
const host=await startBrowserServer(),f=await compositeReportScenario(host.app);
const plan=(await host.app.json('/api/planning/group',{method:'POST',body:{serviceDate:'2026-08-20'}},201)).result;
await host.app.json('/api/planning/group',{method:'PUT',body:{planId:plan.planId}});
const objects=new Map();
globalThis.FixedLengthStream=class extends TransformStream {constructor(){super();}};
globalThis[Symbol.for('mmi.test.cloudflare.env')].MEDIA={
  async put(key,stream,options){const bytes=new Uint8Array(await new Response(stream).arrayBuffer());if(createHash('sha256').update(bytes).digest('hex')!==options.sha256)throw new Error('checksum mismatch');objects.set(key,bytes);},
  async get(key,{range}={}){const bytes=objects.get(key);if(!bytes)return null;const match=/^bytes=(\d+)-(\d*)$/.exec(range?.get('range') ?? '');const offset=match ? Number(match[1]) : 0,end=match&&match[2] ? Math.min(bytes.length,Number(match[2])+1) : bytes.length;
    return{body:bytes.slice(offset,end),size:bytes.length,httpEtag:'"fixture"',...(match?{range:{offset,length:end-offset}}:{})};},
};
const output=new URL('../../.tmp/device-composite/',import.meta.url);await mkdir(output,{recursive:true});
const config={server:host.origin.replace('127.0.0.1','10.0.2.2'),email:host.app.db.prepare("SELECT email FROM users WHERE id='USR-402'").get().email,password:'isolated-test-password',visitId:f.order.id,serviceDate:'2026-08-20'};
await writeFile(new URL('config.json',output),JSON.stringify(config,null,2));
console.log('Isolated device acceptance server ready:',host.origin);
let accepting=false,accepted=false;
const timer=setInterval(async()=>{
  if(accepting||accepted)return;
  if(host.app.db.prepare('SELECT status FROM work_orders WHERE id=?').get(f.order.id).status!=='completed')return;
  accepting=true;
  try {
    const item=(await host.app.json('/api/requests')).items.find(item=>item.id===f.order.id);
    if(item.completionReport.sections.length!==2 || objects.size!==2)throw new Error('Incomplete device report');
    await host.app.json('/api/requests',{method:'PUT',body:{...item,status:'confirmed'}});
    await writeFile(new URL('accepted.json',output),JSON.stringify({planId:plan.planId,jobId:item.id,status:'confirmed',sections:item.completionReport.sections,media:item.completionReport.media,
      histories:host.app.db.prepare('SELECT from_status,to_status,reason FROM work_order_status_history WHERE work_order_id=? ORDER BY rowid').all(item.id),
      mediaHashes:[...objects].map(([key,bytes])=>({key,sha256:createHash('sha256').update(bytes).digest('hex')}))},null,2));
    accepted=true;console.log('Device composite report verified and accepted.');
  } catch(error){console.error(error.message);}finally{accepting=false;}
},1000);
async function close(){clearInterval(timer);await host.close();process.exit();}
process.on('SIGINT',close);process.on('SIGTERM',close);
