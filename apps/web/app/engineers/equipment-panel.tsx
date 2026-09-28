"use client";
import { useEffect,useState } from "react";
import { apiRequest } from "@/app/lib/api-client";
import type { BrigadeEquipment } from "@/app/lib/brigade-equipment";
import type { EquipmentItem,EquipmentSnapshot } from "@/app/lib/work-catalog";
type State={workerId:string;date:string;revision:string;issued:BrigadeEquipment|null;planned:{items:EquipmentSnapshot[];orderIds:string[]};catalog:EquipmentItem[]};

export default function EquipmentPanel({workerId}:{workerId:string}) {
  const [date,setDate]=useState("");const [snapshot,setData]=useState<State|null>(null);const [selected,setSelected]=useState<string[]>([]);
  const data=snapshot?.workerId===workerId && (!date || snapshot.date===date) ? snapshot : null;
  const [reason,setReason]=useState("");const [notice,setNotice]=useState("");const [saving,setSaving]=useState(false);
  useEffect(()=>{let active=true;
    apiRequest<State>(`/api/engineers/equipment?workerId=${encodeURIComponent(workerId)}${date?`&date=${date}`:""}`).then(result=>{if(active){setData(result);setSelected((result.issued ? result.issued.items ?? [] : result.planned.items).map(e=>e.equipmentId));setNotice("");}}).catch((error:Error)=>{if(active)setNotice(error.message);});
    return ()=>{active=false;};
  },[workerId,date]);
  async function save(){if(!data)return;setSaving(true);setNotice("");try{
    const result=await apiRequest<State>("/api/engineers/equipment",{method:"PUT",body:JSON.stringify({workerId,date:data.date,revision:data.revision,equipmentIds:selected,reason:reason.trim() || "Выезд с комплектом на день"})});
    setData(result);setReason("");setNotice("Полученный комплект сохранён. Пересчитайте план.");
  }catch(error){setNotice(error instanceof Error?error.message:"Не удалось сохранить комплект.");}finally{setSaving(false);}}
  return <section className="engineer-form-section" aria-label="Оборудование бригады на день"><h3>Оборудование на день</h3>
    <label><span>День плана</span><input type="date" value={date || data?.date || ""} onChange={event=>setDate(event.target.value)} /></label>
    {data && <><p>{data.issued ? "Бригада выехала. Перепланирование ограничено полученным комплектом." : "Бригада ещё не выехала. Ниже потребность текущих назначений на день; оборудование получают в офисе после планирования."}</p>
      {data.issued?.items===null && <p role="alert">Полученный комплект неизвестен. Укажите, какое оборудование имеется у бригады.</p>}
      <div className="equipment-issue-list">{data.catalog.filter(item=>item.active || selected.includes(item.id)).map(item=><label key={item.id} className="client-confirmation-check"><input type="checkbox" checked={selected.includes(item.id)} onChange={event=>setSelected(current=>event.target.checked?[...current,item.id]:current.filter(id=>id!==item.id))} /><span>{item.name}</span></label>)}</div>
      {!data.catalog.length && <p>Каталог оборудования пока пуст.</p>}
      <small>Проверяется наличие видов оборудования. Количества и расход не рассчитываются.</small>
      {data.issued && <label><span>Причина уточнения комплекта</span><input value={reason} onChange={event=>setReason(event.target.value)} maxLength={1000} /></label>}
      <button type="button" className="stitch-green-button" disabled={saving || Boolean(data.issued && reason.trim().length<3)} onClick={()=>void save()}>{saving?"Сохранение…":data.issued?"Сохранить полученный комплект":"Комплект получен, бригада выехала"}</button>
    </>}{notice && <p role="status">{notice}</p>}
  </section>;
}
