import type { SystemRoleId } from "./role-data";

export type SystemUserStatus = "active" | "offline" | "blocked";

export type SystemUser = {
  id: string;
  initials: string;
  name: string;
  email: string;
  roleId: SystemRoleId | null;
  status: SystemUserStatus;
  statusLabel: string;
  activity: string;
};

export const systemUsers: SystemUser[] = [
  { id: "USR-001", initials: "ИИ", name: "Иван Иванов", email: "ivan.ivanov@route.ru", roleId: "dispatcher", status: "active", statusLabel: "Активен", activity: "Сегодня, 10:45" },
  { id: "USR-002", initials: "ПП", name: "Петр Петров", email: "petr.petrov@route.ru", roleId: "executor", status: "offline", statusLabel: "Не в сети", activity: "Вчера, 18:20" },
  { id: "USR-003", initials: "АС", name: "Анна Сидорова", email: "anna.sidorova@route.ru", roleId: "administrator", status: "blocked", statusLabel: "Заблокирован", activity: "12 Окт 2023" },
  { id: "USR-402", initials: "АИ", name: "Алексей Иванов", email: "a.ivanov@route.ru", roleId: "executor", status: "active", statusLabel: "Активен", activity: "Сегодня, 09:02" },
  { id: "USR-415", initials: "МС", name: "Марина Соколова", email: "m.sokolova@route.ru", roleId: "executor", status: "active", statusLabel: "Активен", activity: "Сегодня, 08:47" },
  { id: "USR-390", initials: "ИК", name: "Илья Козлов", email: "i.kozlov@route.ru", roleId: "executor", status: "offline", statusLabel: "Не в сети", activity: "Вчера, 17:36" },
];
