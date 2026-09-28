import NotificationBell from "./notification-bell";
import type { AuthUser } from "@/auth/session";
import MaterialIcon from "@/app/components/material-icon";
import OrganizationSwitcher from "./organization-switcher";

export type PlanningScope = { departments: Array<{id:string;name:string}>; selectedId:string; onChange:(id:string)=>void };
type DispatcherTopbarProps = { user: AuthUser; planningScope?: PlanningScope };

export default function DispatcherTopbar({ user, planningScope }: DispatcherTopbarProps) {
  return (
    <header className="dispatcher-topbar">
      <div className="dispatcher-topbar-main">
        {planningScope ? <label className="dispatcher-organization-select"><MaterialIcon name="corporate_fare" /><span className="sr-only">Подразделение</span>
          <select aria-label="Подразделение" value={planningScope.selectedId} onChange={event=>planningScope.onChange(event.target.value)}>
            <option value="all">Все подразделения</option>{planningScope.departments.map(d=><option key={d.id} value={d.id}>{d.name}</option>)}
          </select></label> : <OrganizationSwitcher />}
        <label className="dispatcher-system-search">
          <MaterialIcon name="search" />
          <span className="sr-only">Поиск по системе</span>
          <input type="search" placeholder="Поиск по системе..." />
        </label>
      </div>
      <div className="dispatcher-account-actions">
        <button type="button" aria-label="Помощь"><MaterialIcon name="help_outline" /></button>
        <span className="dispatcher-topbar-divider" />
        <NotificationBell key={planningScope ? `${planningScope.selectedId}:${planningScope.departments.map(d=>d.id).join(",")}` : "current"}
          organizationIds={planningScope?.departments.filter(d=>planningScope.selectedId==="all" || d.id===planningScope.selectedId).map(d=>d.id)} />
        <form action="/api/auth/logout" method="post">
          <button className="dispatcher-account-avatar" type="submit" title="Выйти" aria-label={`Выйти из профиля ${user.displayName}`}>
            {getInitials(user.displayName)}
          </button>
        </form>
      </div>
    </header>
  );
}

function getInitials(name: string) {
  return name.split(/\s+/u).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join("") || "П";
}
