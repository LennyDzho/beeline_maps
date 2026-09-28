export type SystemRoleId = "dispatcher" | "executor" | "administrator";

export type PermissionId =
  | "requests.view"
  | "requests.manage"
  | "planning.manage"
  | "engineers.manage"
  | "resources.manage"
  | "reports.view"
  | "mobile.execute"
  | "admin.users"
  | "admin.roles"
  | "admin.settings";

export type PermissionDefinition = {
  id: PermissionId;
  label: string;
  description: string;
};

export type SystemRole = {
  id: SystemRoleId;
  name: string;
  description: string;
  icon: string;
  permissions: PermissionId[];
};

export const permissionCatalog: PermissionDefinition[] = [
  { id: "requests.view", label: "Просмотр заявок", description: "Список и карточки заявок" },
  { id: "requests.manage", label: "Управление заявками", description: "Создание, изменение и подтверждение" },
  { id: "planning.manage", label: "Планирование выездов", description: "Маршруты и назначение исполнителей" },
  { id: "engineers.manage", label: "Управление исполнителями", description: "Карточки и рабочие параметры" },
  { id: "resources.manage", label: "Управление ресурсами", description: "Транспорт и оборудование" },
  { id: "reports.view", label: "Просмотр отчётов", description: "Аналитика и экспорт" },
  { id: "mobile.execute", label: "Выполнение работ", description: "Мобильные задания и отчёты" },
  { id: "admin.users", label: "Управление пользователями", description: "Учётные записи и статусы" },
  { id: "admin.roles", label: "Управление ролями", description: "Права и назначения ролей" },
  { id: "admin.settings", label: "Системные настройки", description: "Параметры приложения" },
];

export const initialRoles: SystemRole[] = [
  { id: "dispatcher", name: "Диспетчер", description: "Планирование, заявки и контроль выполнения", icon: "support_agent", permissions: ["requests.view", "requests.manage", "planning.manage", "engineers.manage", "resources.manage", "reports.view"] },
  { id: "executor", name: "Исполнитель", description: "Работа с назначенными заданиями в мобильном приложении", icon: "engineering", permissions: ["requests.view", "mobile.execute"] },
  { id: "administrator", name: "Администратор", description: "Полный доступ к системе и управлению пользователями", icon: "admin_panel_settings", permissions: permissionCatalog.map((permission) => permission.id) },
];

export const roleLabels: Record<SystemRoleId, string> = {
  dispatcher: "Диспетчер",
  executor: "Исполнитель",
  administrator: "Администратор",
};
