"use client";

import { useEffect, useState } from "react";
import { apiRequest } from "@/app/lib/api-client";

type Availability = { workerId:string; timezone:string; activityRevision:string; activities:{id:string;number:string;status:string}[];
  estimate:{availableAt:string;address:string;stale:boolean}|null };

export default function AvailabilityPanel({ workerId }: {workerId:string}) {
  const [current,setCurrent]=useState<Availability|null>(null);
  const [availableAt,setAvailableAt]=useState("");
  const [address,setAddress]=useState("");
  const [message,setMessage]=useState("");
  const [saving,setSaving]=useState(false);
  useEffect(()=>{
    let active=true;
    apiRequest<Availability>(`/api/engineers/availability?workerId=${encodeURIComponent(workerId)}`)
      .then(data=>{if(active){setCurrent(data);setAvailableAt(data.estimate?.availableAt ?? "");setAddress(data.estimate?.address ?? "");}})
      .catch((error:Error)=>{if(active)setMessage(error.message);});
    return ()=>{active=false;};
  },[workerId]);
  async function save(clear=false) {
    if (!current || saving) return;
    setSaving(true);setMessage("");
    try {
      const result=await apiRequest<Availability>("/api/engineers/availability",{method:"PUT",body:JSON.stringify({workerId,activityRevision:current.activityRevision,availableAt:clear?null:availableAt,address})});
      setCurrent(result);setAvailableAt(result.estimate?.availableAt ?? "");setAddress(result.estimate?.address ?? "");
      setMessage(clear?"Оценка удалена.":"Оценка сохранена. Пересчитайте план.");
    } catch(error) {setMessage(error instanceof Error?error.message:"Не удалось сохранить оценку.");}
    finally {setSaving(false);}
  }
  return <section className="engineer-form-section" aria-label="Доступность для перепланирования">
    <h3>Когда бригада сможет продолжить маршрут</h3>
    <p>Укажите время освобождения и адрес, если бригада уже выполняет работу. Перепланирование начнёт оставшийся маршрут с этой точки. После изменения статуса текущей заявки оценку нужно уточнить. Сохраняется отдельной кнопкой.</p>
    {current && <>
      {current.activities.length>0 && <p>Защищённые заявки: {current.activities.map(a=>`№${a.number}`).join(", ")}</p>}
      {current.estimate?.stale && <p role="alert">Оценка устарела. Уточните освобождение и сохраните её заново.</p>}
      <div className="engineer-field-grid">
        <label><span>Свободен с ({current.timezone})</span><input type="datetime-local" value={availableAt} onChange={e=>setAvailableAt(e.target.value)} /></label>
        <label><span>Адрес продолжения маршрута</span><input value={address} onChange={e=>setAddress(e.target.value)} maxLength={1000} /></label>
      </div>
      <div className="availability-actions"><button className="stitch-green-button" type="button" disabled={saving || !availableAt || !address.trim()} onClick={()=>void save()}>{saving?"Сохранение…":"Сохранить доступность"}</button>
      {current.estimate && <button type="button" disabled={saving} onClick={()=>void save(true)}>Удалить оценку</button>}</div>
    </>}
    {message && <p role="status">{message}</p>}
  </section>;
}
