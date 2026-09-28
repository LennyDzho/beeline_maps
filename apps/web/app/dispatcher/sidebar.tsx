import MaterialIcon from "@/app/components/material-icon";

const navigation = [
  { id: "planning", icon: "calendar_month", label: "Планирование", href: "/" },
  { id: "requests", icon: "assignment", label: "Заявки", href: "/requests" },
  { id: "engineers", icon: "engineering", label: "Исполнители", href: "/engineers" },
  { id: "resources", icon: "inventory_2", label: "Ресурсы", href: "/resources" },
  { id: "reports", icon: "bar_chart", label: "Отчёты", href: "/reports" },
  { id: "admin", icon: "settings", label: "Администрирование", href: "/admin" },
] as const;

type DispatcherSidebarProps = {
  active?: (typeof navigation)[number]["id"];
  subtitle?: string;
};

export default function DispatcherSidebar({ active = "planning", subtitle = "Диспетчерская" }: DispatcherSidebarProps) {
  return (
    <aside className="stitch-sidebar">
      <div className="stitch-sidebar-brand">
        <strong>Марш!</strong>
        <span>{subtitle}</span>
      </div>

      <nav aria-label="Основная навигация">
        {navigation.map((item) => {
          const isActive = item.id === active;
          const content = <><MaterialIcon name={item.icon} filled={isActive} /><span>{item.label}</span></>;

          return (
            <a className={`stitch-nav-item ${isActive ? "active" : ""}`} href={item.href} aria-current={isActive ? "page" : undefined} key={item.id}>
              {content}
            </a>
          );
        })}
      </nav>
    </aside>
  );
}
