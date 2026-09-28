import type { Engineer } from "./data.js";

type Request = {id:string;number?:string;status:string;executionStatus?:'en_route'|'in_progress';dateTime:string;assignee:string;assigneeId?:string};
type Worker = {id:string;name:string;vehicle:string;load:number};

/** Protected entries are shown separately from the recalculated, unstarted tail. */
export function appendProtectedVisits(cards:Engineer[],requests:Request[],workers:Worker[],serviceDate:string):Engineer[] {
  const protectedRequests=requests.filter(r=>(r.executionStatus || r.status==='en_route' || r.status==='in_progress') && r.dateTime.slice(0,10)===serviceDate);
  const ids=new Set(protectedRequests.map(r=>r.id));
  const result=cards.map(card=>({...card,visits:card.visits.filter(v=>!v.requestId || !ids.has(v.requestId))}));
  for (const worker of workers) {
    const owned=protectedRequests.filter(r=>r.assigneeId ? r.assigneeId===worker.id : r.assignee===worker.name);
    if (!owned.length) continue;
    let card=result.find(c=>c.id===worker.id);
    if (!card) {
      card={id:worker.id,name:worker.name,vehicle:worker.vehicle,load:worker.load,accent:'violet',initials:worker.name.split(/\s+/u).slice(0,2).map(p=>p[0]).join(''),visits:[],routeSummary:'Начатые заявки сохранены'};
      result.push(card);
    }
    card.visits.unshift(...owned.map(r=>({requestId:r.id,time:r.dateTime.slice(11,16),label:`Заявка ${r.number ?? "Без номера"}`,protectedStatus:r.executionStatus ?? r.status as 'en_route'|'in_progress'})));
  }
  return result;
}
