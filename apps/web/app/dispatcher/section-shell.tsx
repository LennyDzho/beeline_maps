import type { ReactNode } from "react";
import type { AuthUser } from "@/auth/session";
import DispatcherSidebar from "./sidebar";
import DispatcherTopbar, { type PlanningScope } from "./topbar";

type SectionId = "planning" | "requests" | "engineers" | "resources" | "reports" | "admin";

type DispatcherSectionShellProps = {
  user: AuthUser;
  active: SectionId;
  children: ReactNode;
  className?: string;
  planningScope?: PlanningScope;
};

export default function DispatcherSectionShell({ user, active, children, className = "", planningScope }: DispatcherSectionShellProps) {
  return (
    <div className={`stitch-dispatcher-shell section-shell ${className}`.trim()}>
      <DispatcherSidebar active={active} subtitle="Диспетчерская панель" />
      <div className="dispatcher-area section-area">
        <DispatcherTopbar user={user} planningScope={planningScope} />
        {children}
      </div>
    </div>
  );
}
