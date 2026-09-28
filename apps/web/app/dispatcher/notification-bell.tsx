"use client";

import { useCallback,useEffect,useRef,useState } from "react";
import MaterialIcon from "@/app/components/material-icon";
import { apiRequest } from "@/app/lib/api-client";
import type { DispatcherNotification,NotificationFeed } from "@/app/lib/dispatcher-notifications";

type Notice=DispatcherNotification & {organizationId:string;timezone:string};
const scoped=(feed:NotificationFeed,items:DispatcherNotification[]):Notice[]=>items.map(item=>({...item,organizationId:feed.organizationId,timezone:feed.timezone}));
const headers=(organizationId:string)=>({"X-MMI-Organization":organizationId});

export default function NotificationBell({organizationIds}:{organizationIds?:string[]}) {
  const [feeds,setFeeds]=useState<NotificationFeed[]>([]);
  const [journal,setJournal]=useState(false),[queue,setQueue]=useState<Notice[]>([]),[error,setError]=useState("");
  const [older,setOlder]=useState<Notice[]>([]),[beforeByOrganization,setBefore]=useState<Record<string,number|null>>({});
  const [markingRead,setMarkingRead]=useState(false);
  const readRevision=useRef(0),markingReadRef=useRef(false);
  const seen=useRef(new Set<number>()),delivered=useRef(new Map<string,number>()),inFlight=useRef(false),active=useRef(false);
  // The topbar remounts this component when the visible department scope changes.
  const scopeKey=JSON.stringify(organizationIds ?? null);
  const refresh=useCallback(async()=>{
    if(inFlight.current || markingReadRef.current)return;inFlight.current=true;
    const revision=readRevision.current;
    try {
      const scope=JSON.parse(scopeKey) as string[]|null;
      const results=await Promise.all((scope ?? [null]).map(id=>apiRequest<NotificationFeed>("/api/notifications",id?{headers:headers(id)}:undefined)));
      if(!active.current || revision!==readRevision.current)return;
      setFeeds(results);setError("");
      const incoming:Notice[]=[];
      for(const result of results) {
        if(!result.initialized) {
          await apiRequest("/api/notifications",{method:"PUT",headers:headers(result.organizationId),body:JSON.stringify({action:"delivered",sequence:result.latest})});
          delivered.current.set(result.organizationId,result.latest);
        } else {
          incoming.push(...scoped(result,result.pending.filter(item=>!item.read && !seen.current.has(item.sequence))));
          const cursor=delivered.current.get(result.organizationId) ?? 0;
          if(cursor>result.cursor)await apiRequest("/api/notifications",{method:"PUT",headers:headers(result.organizationId),body:JSON.stringify({action:"delivered",sequence:cursor})});
        }
      }
      if(!active.current || revision!==readRevision.current)return;
      incoming.sort((a,b)=>a.sequence-b.sequence).forEach(item=>seen.current.add(item.sequence));
      setQueue(current=>[...current,...incoming]);
    } catch(reason) {if(active.current)setError(reason instanceof Error?reason.message:"Не удалось загрузить уведомления.");}
    finally{inFlight.current=false;}
  },[scopeKey]);
  useEffect(()=>{
    active.current=true;
    const initial=window.setTimeout(()=>void refresh(),0);
    const poll=()=>{if(!document.hidden)void refresh();};
    const timer=window.setInterval(poll,3000);window.addEventListener("focus",poll);
    return()=>{active.current=false;window.clearTimeout(initial);window.clearInterval(timer);window.removeEventListener("focus",poll);};
  },[refresh]);
  const toast=queue[0];
  useEffect(()=>{
    if(!toast)return;
    delivered.current.set(toast.organizationId,Math.max(delivered.current.get(toast.organizationId) ?? 0,toast.sequence));
    void apiRequest("/api/notifications",{method:"PUT",headers:headers(toast.organizationId),body:JSON.stringify({action:"delivered",sequence:toast.sequence})}).catch(()=>{/* Polling retries the acknowledgement. */});
    const timer=window.setTimeout(()=>setQueue(current=>current.filter(item=>item.sequence!==toast.sequence)),10000);
    return()=>window.clearTimeout(timer);
  },[toast]);
  async function open(item:Notice) {
    try {
      await apiRequest("/api/notifications",{method:"PUT",headers:headers(item.organizationId),body:JSON.stringify({action:"read",sequences:[item.sequence]})});
      await apiRequest("/api/organization-context",{method:"PUT",body:JSON.stringify({organizationId:item.organizationId})});
      window.location.assign(`/requests?open=${encodeURIComponent(item.orderId)}`);
    } catch(reason){setError(reason instanceof Error?reason.message:"Не удалось открыть заявку.");}
  }
  async function markRead(item?:Notice) {
    if(markingReadRef.current)return;
    markingReadRef.current=true;setMarkingRead(true);setError("");readRevision.current++;
    try {
      const targets=item ? feeds.filter(feed=>feed.organizationId===item.organizationId) : feeds.filter(feed=>feed.unread>0);
      for(const feed of targets) {
        await apiRequest("/api/notifications",{method:"PUT",headers:headers(feed.organizationId),body:JSON.stringify(item
          ? {action:"read",sequences:[item.sequence]}
          : {action:"read_all",throughSequence:feed.latest})});
        const matches=(notice:DispatcherNotification & {organizationId?:string})=>(!notice.organizationId || notice.organizationId===feed.organizationId)
          && (item ? notice.sequence===item.sequence : notice.sequence<=feed.latest);
        setFeeds(current=>current.map(value=>value.organizationId!==feed.organizationId ? value : {...value,
          unread:item ? Math.max(0,value.unread-1) : 0,
          items:value.items.map(notice=>matches(notice)?{...notice,read:true}:notice),
          pending:value.pending.map(notice=>matches(notice)?{...notice,read:true}:notice)}));
        setOlder(current=>current.map(notice=>matches(notice)?{...notice,read:true}:notice));
        setQueue(current=>current.filter(notice=>!matches(notice)));
      }
    } catch(reason){setError(reason instanceof Error?reason.message:"Не удалось отметить уведомления прочитанными.");}
    finally{readRevision.current++;markingReadRef.current=false;setMarkingRead(false);void refresh();}
  }
  const nextPages=feeds.map(feed=>({feed,before:beforeByOrganization[feed.organizationId]===undefined?feed.nextBefore:beforeByOrganization[feed.organizationId]})).filter(item=>item.before);
  async function loadOlder() {
    const revision=readRevision.current;
    try {
      const results=await Promise.all(nextPages.map(({feed,before})=>apiRequest<NotificationFeed>(`/api/notifications?before=${before}`,{headers:headers(feed.organizationId)})));
      if(revision!==readRevision.current)return;
      setOlder(current=>[...current,...results.flatMap(feed=>scoped(feed,feed.items))]);
      setBefore(current=>({...current,...Object.fromEntries(results.map(feed=>[feed.organizationId,feed.nextBefore]))}));
    } catch(reason){setError(reason instanceof Error?reason.message:"Не удалось загрузить журнал.");}
  }
  const items=[...new Map([...feeds.flatMap(feed=>scoped(feed,feed.items)),...older].map(item=>[item.sequence,item])).values()].sort((a,b)=>b.sequence-a.sequence);
  const unread=feeds.reduce((sum,feed)=>sum+feed.unread,0);
  return <>
    <button type="button" className="notification-bell" aria-label={`Уведомления${unread?`: ${unread} непрочитанных`:""}`} aria-expanded={journal} onClick={()=>setJournal(value=>!value)}><MaterialIcon name="notifications" />{Boolean(unread)&&<span>{unread}</span>}</button>
    {toast&&<div className="dispatcher-event-toast" role="status"><button type="button" onClick={()=>void open(toast)}><strong>{toast.title}</strong><span>{toast.detail}</span><small>Открыть заявку</small></button></div>}
    {journal&&<section className="notification-journal" role="dialog" aria-label="Журнал уведомлений">
      <header><h2>Журнал уведомлений</h2><button type="button" onClick={()=>setJournal(false)} aria-label="Закрыть журнал">×</button></header>
      <div className="notification-journal-actions"><button type="button" disabled={!unread || markingRead} onClick={()=>void markRead()}>{markingRead?"Сохранение…":"Прочитать все"}</button><small>В выбранных подразделениях</small></div>
      {error&&<p role="alert">{error}</p>}{!items.length&&<p>Сообщений пока нет.</p>}
      <ul>{items.map(item=><li key={item.sequence} className={item.read?"read":"unread"}><button type="button" onClick={()=>void open(item)}><strong>{item.title}</strong><span>{item.detail}</span><time dateTime={item.createdAt}>{new Intl.DateTimeFormat("ru-RU",{day:"2-digit",month:"2-digit",hour:"2-digit",minute:"2-digit",timeZone:item.timezone}).format(new Date(item.createdAt))}</time></button>{item.read ? <small className="notification-read-label">Прочитано</small> : <button className="notification-mark-read" type="button" disabled={markingRead} aria-label={`Отметить прочитанным: ${item.title}`} onClick={()=>void markRead(item)}>Отметить прочитанным</button>}</li>)}</ul>
      {nextPages.length>0&&<button type="button" onClick={()=>void loadOlder()}>Ранее</button>}
    </section>}
  </>;
}
