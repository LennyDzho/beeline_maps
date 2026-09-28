import MaterialIcon from "@/app/components/material-icon";

type MobileNavProps = {
  active: "today" | "notifications" | "profile";
};

export default function MobileNav({ active }: MobileNavProps) {
  const items = [
    { id: "today", icon: "today", label: "Сегодня", href: "/mobile/today" },
    { id: "notifications", icon: "notifications", label: "Уведомления" },
    { id: "profile", icon: "person", label: "Профиль" },
  ] as const;

  return (
    <nav className="mobile-bottom-nav" aria-label="Навигация мобильного приложения">
      {items.map((item) => "href" in item ? (
        <a className={active === item.id ? "active" : ""} href={item.href} key={item.id}>
          <span><MaterialIcon name={item.icon} filled={active === item.id} /></span>
          {item.label}
        </a>
      ) : (
        <button className={active === item.id ? "active" : ""} type="button" key={item.id}>
          <span><MaterialIcon name={item.icon} filled={active === item.id} /></span>
          {item.label}
        </button>
      ))}
    </nav>
  );
}
