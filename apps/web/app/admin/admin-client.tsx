"use client";

import { useEffect, useState, type KeyboardEvent } from "react";
import type { AuthUser } from "@/auth/session";
import { regionTimezones } from "@/app/lib/regional-time";
import MaterialIcon from "@/app/components/material-icon";
import Pagination from "@/app/components/pagination";
import DispatcherSectionShell from "@/app/dispatcher/section-shell";
import { usePagination } from "@/app/hooks/use-pagination";
import { apiRequest } from "@/app/lib/api-client";
import {
  DEFAULT_PLANNING_SETTINGS,
  DEFAULT_CALCULATION_TIMEOUT_SECONDS, isCalculationTimeoutSeconds,
  DEFAULT_OPTIMIZER_POLICY, OPTIMIZER_POLICY_OPTIONS, isOptimizerPolicy, type OptimizerPolicy,
  OPTIMIZATION_ENGINE_OPTIONS,
  OSRM_TRAVEL_WARNING,
  TRAVEL_MATRIX_PROVIDER_OPTIONS,
  isOptimizationEngineId,
  isTravelMatrixProviderId,
  type OptimizationEngineId,
  type PlanningSettings,
  type TravelMatrixProviderId,
} from "@/app/lib/planning-settings";
import { systemUsers, type SystemUser } from "./user-data";
import RolesPanel from "./roles-panel";
import { initialRoles, roleLabels, type PermissionId, type SystemRoleId } from "./role-data";
import UserEditor, { type UserSavePayload } from "./user-editor";
import RoleChangeDialog from "./role-change-dialog";
import WorkTypesPanel from "./work-types-panel";
import WorkTypeEditor from "./work-type-editor";
import { initialWorkTypes, type WorkTypeRecord } from "./work-type-data";
import WorkSchedulesPanel from "./work-schedules-panel";
import WorkScheduleEditor from "./work-schedule-editor";
import type { WorkScheduleRecord } from "./work-schedule-data";

import CategoryEditor from "./category-editor";
import type { WorkCategory, EquipmentItem } from "@/app/lib/work-catalog";

type AdminTab = "users" | "roles" | "catalog" | "settings";
type UserEditorState = { mode: "create" } | { mode: "edit"; user: SystemUser };
type RoleChange = { userId: string; userName: string; fromRoleId: SystemRoleId; toRoleId: SystemRoleId };
type WorkTypeEditorState = { mode: "create"; categoryId?: string } | { mode: "edit"; workType: WorkTypeRecord };
type WorkScheduleEditorState = { mode: "create" } | { mode: "edit"; schedule: WorkScheduleRecord };
type AdminSettings = PlanningSettings & { timezone: string; officeAddress: string };

const DEFAULT_ADMIN_SETTINGS: AdminSettings = {
  timezone: "Europe/Moscow",
  officeAddress: "",
  ...DEFAULT_PLANNING_SETTINGS,
};

export default function AdminClient({ user }: { user: AuthUser }) {
  const [tab, setTab] = useState<AdminTab>("settings");
  const [userRows, setUserRows] = useState(systemUsers);
  const [roles, setRoles] = useState(initialRoles);
  const [selectedRoleId, setSelectedRoleId] = useState<SystemRoleId>("dispatcher");
  const [officeAddress, setOfficeAddress] = useState("");
  const [timezone, setTimezone] = useState("Europe/Moscow");
  const [savingSettings, setSavingSettings] = useState({ department: false, planning: false });
  const [calculationTimeoutSeconds, setCalculationTimeoutSeconds] = useState(String(DEFAULT_CALCULATION_TIMEOUT_SECONDS));
  const [optimizationEngine, setOptimizationEngine] = useState<OptimizationEngineId>(DEFAULT_PLANNING_SETTINGS.optimizationEngine);
  const [optimizerPolicy, setOptimizerPolicy] = useState<OptimizerPolicy>(DEFAULT_OPTIMIZER_POLICY);
  const [travelMatrixProvider, setTravelMatrixProvider] = useState<TravelMatrixProviderId>(DEFAULT_PLANNING_SETTINGS.travelMatrixProvider);
  const [savedSettings, setSavedSettings] = useState<AdminSettings>(DEFAULT_ADMIN_SETTINGS);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [notice, setNotice] = useState("");
  const [userEditor, setUserEditor] = useState<UserEditorState | null>(null);
  const [roleDraftAssignments, setRoleDraftAssignments] = useState<Record<string, SystemRoleId | null>>({});
  const [roleChangeQueue, setRoleChangeQueue] = useState<RoleChange[]>([]);
  const [roleChangeTotal, setRoleChangeTotal] = useState(0);
  const [workCategories, setWorkCategories] = useState<WorkCategory[]>([]);
  const [categoryEditor, setCategoryEditor] = useState<{category: WorkCategory | null; equipmentOnly: boolean} | null>(null);
  const [equipmentItems, setEquipmentItems] = useState<EquipmentItem[]>([]);
  const [workTypes, setWorkTypes] = useState(initialWorkTypes);
  const [workTypeEditor, setWorkTypeEditor] = useState<WorkTypeEditorState | null>(null);
  const [workSchedules, setWorkSchedules] = useState<WorkScheduleRecord[]>([]);
  const [workScheduleEditor, setWorkScheduleEditor] = useState<WorkScheduleEditorState | null>(null);
  const userPagination = usePagination(userRows, 6);

  useEffect(() => {
    let active = true;
    apiRequest<{ users: SystemUser[]; roles: typeof initialRoles; workTypes: WorkTypeRecord[]; workSchedules: WorkScheduleRecord[]; workCategories: WorkCategory[]; equipmentItems: EquipmentItem[]; settings: AdminSettings }>("/api/admin/bootstrap")
      .then((data) => {
        if (!active) return;
        setUserRows(data.users);
        setRoles(data.roles);
        setWorkTypes(data.workTypes); setWorkCategories(data.workCategories); setEquipmentItems(data.equipmentItems);
        setWorkSchedules(data.workSchedules);
        setTimezone(data.settings.timezone);
        setCalculationTimeoutSeconds(String(data.settings.calculationTimeoutSeconds ?? DEFAULT_CALCULATION_TIMEOUT_SECONDS));
        setOfficeAddress(data.settings.officeAddress);
        setOptimizationEngine(data.settings.optimizationEngine);
        setOptimizerPolicy(data.settings.optimizerPolicy ?? DEFAULT_OPTIMIZER_POLICY);
        setTravelMatrixProvider(data.settings.travelMatrixProvider);
        setSavedSettings(data.settings);
        setSettingsLoaded(true);
      })
      .catch((error: Error) => { if (active) setNotice(error.message); });
    return () => { active = false; };
  }, []);

  function showNotice(message: string) {
    setNotice(message);
    window.setTimeout(() => setNotice(""), 4000);
  }

  function togglePermission(permissionId: PermissionId) {
    setRoles((current) => current.map((role) => role.id === selectedRoleId ? {
      ...role,
      permissions: role.permissions.includes(permissionId)
        ? role.permissions.filter((item) => item !== permissionId)
        : [...role.permissions, permissionId],
    } : role));
  }

  function toggleRoleUser(userId: string) {
    const actualRoleId = userRows.find((item) => item.id === userId)?.roleId ?? null;
    setRoleDraftAssignments((current) => {
      const displayedRoleId = Object.prototype.hasOwnProperty.call(current, userId) ? current[userId] ?? null : actualRoleId;
      const nextRoleId = displayedRoleId === selectedRoleId ? null : selectedRoleId;
      const next = { ...current };
      if (nextRoleId === actualRoleId) delete next[userId];
      else next[userId] = nextRoleId;
      return next;
    });
  }

  async function saveRoleChanges() {
    const changes = userRows.flatMap((userItem) => {
      if (!Object.prototype.hasOwnProperty.call(roleDraftAssignments, userItem.id)) return [];
      const toRoleId = roleDraftAssignments[userItem.id] ?? null;
      return toRoleId === userItem.roleId ? [] : [{ userItem, toRoleId }];
    });
    const transfers: RoleChange[] = changes.flatMap(({ userItem, toRoleId }) => userItem.roleId && toRoleId ? [{ userId: userItem.id, userName: userItem.name, fromRoleId: userItem.roleId, toRoleId }] : []);
    const directAssignments = new Map(changes.filter(({ userItem, toRoleId }) => !userItem.roleId || !toRoleId).map(({ userItem, toRoleId }) => [userItem.id, toRoleId]));

    try {
      const selectedRole = roles.find((role) => role.id === selectedRoleId);
      if (selectedRole) await apiRequest("/api/admin/roles", { method: "PUT", body: JSON.stringify({ id: selectedRole.id, permissions: selectedRole.permissions }) });
      if (directAssignments.size > 0) {
        await Promise.all([...directAssignments].map(([id, roleId]) => apiRequest("/api/admin/users", { method: "PATCH", body: JSON.stringify({ id, roleId }) })));
        setUserRows((current) => current.map((item) => directAssignments.has(item.id) ? { ...item, roleId: directAssignments.get(item.id) ?? null } : item));
      }
      setRoleDraftAssignments(Object.fromEntries(transfers.map((change) => [change.userId, change.toRoleId])));
      if (transfers.length > 0) {
        setRoleChangeTotal(transfers.length);
        setRoleChangeQueue(transfers);
      } else showNotice(changes.length > 0 ? "Права и назначения ролей сохранены." : "Изменений назначений ролей нет. Права доступа сохранены.");
    } catch (error) { showNotice(error instanceof Error ? error.message : "Не удалось сохранить роли."); }
  }

  async function resolveCurrentRoleChange(approve: boolean) {
    const currentChange = roleChangeQueue[0];
    if (!currentChange) return;
    try {
      if (approve) {
        await apiRequest("/api/admin/users", { method: "PATCH", body: JSON.stringify({ id: currentChange.userId, roleId: currentChange.toRoleId }) });
        setUserRows((current) => current.map((item) => item.id === currentChange.userId ? { ...item, roleId: currentChange.toRoleId } : item));
      }
    } catch (error) {
      showNotice(error instanceof Error ? error.message : "Не удалось изменить роль пользователя.");
      return;
    }
    setRoleDraftAssignments((current) => {
      const next = { ...current };
      delete next[currentChange.userId];
      return next;
    });
    const remaining = roleChangeQueue.slice(1);
    setRoleChangeQueue(remaining);
    if (remaining.length === 0) {
      setRoleChangeTotal(0);
      showNotice("Проверка смены ролей завершена. Решения применены.");
    }
  }

  function openEditUser(userItem: SystemUser) {
    setUserEditor({ mode: "edit", user: userItem });
  }

  function handleUserRowKeyDown(event: KeyboardEvent<HTMLTableRowElement>, userItem: SystemUser) {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openEditUser(userItem);
    }
  }

  async function saveUser(payload: UserSavePayload) {
    try {
      const editing = userEditor?.mode === "edit";
      const requestPayload = editing ? { ...payload, user: { ...payload.user, id: userEditor.user.id } } : payload;
      const data = await apiRequest<{ item: SystemUser }>("/api/admin/users", { method: editing ? "PUT" : "POST", body: JSON.stringify(requestPayload) });
      setUserRows((current) => editing ? current.map((item) => item.id === data.item.id ? data.item : item) : [data.item, ...current]);
      if (!editing) userPagination.resetPage();
      setRoleDraftAssignments((current) => { const next = { ...current }; delete next[data.item.id]; return next; });
      showNotice(editing ? `Пользователь ${data.item.name} обновлён.` : `Пользователь ${data.item.name} создан.`);
      setUserEditor(null);
    } catch (error) { showNotice(error instanceof Error ? error.message : "Не удалось сохранить пользователя."); }
  }

  async function saveWorkType(savedWorkType: WorkTypeRecord) {
    try {
      const editing = workTypeEditor?.mode === "edit";
      const payload = editing ? { ...savedWorkType, id: workTypeEditor.workType.id } : savedWorkType;
      const data = await apiRequest<{ item: WorkTypeRecord }>("/api/admin/work-types", { method: editing ? "PUT" : "POST", body: JSON.stringify(payload) });
      setWorkTypes((current) => editing ? current.map((item) => item.id === data.item.id ? data.item : item) : [data.item, ...current]);
      showNotice(editing ? `Тип работ «${data.item.name}» обновлён.` : `Тип работ «${data.item.name}» создан.`);
      setWorkTypeEditor(null);
    } catch (error) { showNotice(error instanceof Error ? error.message : "Не удалось сохранить тип работ."); }
  }

  async function saveSettings(scope: "department" | "planning") {
    if (scope === "planning" && !isCalculationTimeoutSeconds(Number(calculationTimeoutSeconds))) {
      showNotice("Время расчёта должно быть целым числом от 30 до 1800 секунд.");
      return;
    }
    setSavingSettings(current => ({ ...current, [scope]: true }));
    try {
      const payload = scope === "department" ? { scope, timezone, officeAddress } : { scope, optimizationEngine, travelMatrixProvider, optimizerPolicy, calculationTimeoutSeconds: Number(calculationTimeoutSeconds) };
      const data = await apiRequest<{ settings: Partial<AdminSettings> }>("/api/admin/settings", { method: "PUT", body: JSON.stringify(payload) });
      setSavedSettings(current => ({ ...current, ...data.settings }));
      showNotice(scope === "department" ? "Настройки подразделения сохранены." : "Настройки планирования сохранены для всех подразделений.");
    } catch (error) { showNotice(error instanceof Error ? error.message : "Не удалось сохранить настройки."); }
    finally { setSavingSettings(current => ({ ...current, [scope]: false })); }
  }

  async function saveWorkSchedule(schedule: WorkScheduleRecord) {
    try {
      const editing = workScheduleEditor?.mode === "edit";
      const payload = editing ? { ...schedule, id: workScheduleEditor.schedule.id } : schedule;
      const data = await apiRequest<{ item: WorkScheduleRecord }>("/api/admin/work-schedules", { method: editing ? "PUT" : "POST", body: JSON.stringify(payload) });
      setWorkSchedules((current) => editing ? current.map((item) => item.id === data.item.id ? data.item : item) : [...current, data.item]);
      showNotice(editing ? `График «${data.item.name}» обновлён.` : `График «${data.item.name}» создан.`);
      setWorkScheduleEditor(null);
    } catch (error) { showNotice(error instanceof Error ? error.message : "Не удалось сохранить рабочий график."); }
  }

  const displayedRoleUsers = userRows.map((item) => Object.prototype.hasOwnProperty.call(roleDraftAssignments, item.id) ? { ...item, roleId: roleDraftAssignments[item.id] ?? null } : item);

  return (
    <DispatcherSectionShell user={user} active="admin" className="admin-shell">
      <main className="desktop-section admin-page">
        <header className="section-heading action-heading">
          <div><h1>Администрирование</h1><p>Пользователи, роли и системные настройки</p></div>
          {tab === "users" && <button className="stitch-green-button" type="button" onClick={() => setUserEditor({ mode: "create" })}><MaterialIcon name="person_add" />Добавить пользователя</button>}
        </header>

        <div className="admin-tabs" role="tablist" aria-label="Разделы администрирования">
          <button className={tab === "settings" ? "active" : ""} type="button" role="tab" aria-selected={tab === "settings"} onClick={() => setTab("settings")}>Настройки</button>
          <button className={tab === "users" ? "active" : ""} type="button" role="tab" aria-selected={tab === "users"} onClick={() => setTab("users")}>Пользователи</button>
          <button className={tab === "roles" ? "active" : ""} type="button" role="tab" aria-selected={tab === "roles"} onClick={() => setTab("roles")}>Роли</button>
          <button className={tab === "catalog" ? "active" : ""} type="button" role="tab" aria-selected={tab === "catalog"} onClick={() => setTab("catalog")}>Типы заявок</button>
        </div>

        {tab === "users" &&
          <section className="stitch-table-card admin-users-card" aria-label="Пользователи системы">
            <div className="table-scroll"><table className="stitch-data-table admin-users-table"><thead><tr><th>Пользователь</th><th>Роль</th><th>Статус</th><th>Последняя активность</th><th>Действия</th></tr></thead><tbody>{userPagination.pageItems.map((item) => <tr className="admin-user-row" key={item.id} tabIndex={0} aria-label={`Редактировать пользователя ${item.name}`} onClick={() => openEditUser(item)} onKeyDown={(event) => handleUserRowKeyDown(event, item)}><td><div className="admin-user"><span>{item.initials}</span><div><strong>{item.name}</strong><small>{item.email}</small></div></div></td><td><span className="role-chip">{item.roleId ? roleLabels[item.roleId] : "Без роли"}</span></td><td><span className={`admin-status ${item.status}`}><i />{item.statusLabel}</span></td><td>{item.activity}</td><td><button className="table-action visible-action" type="button" aria-label={`Редактировать пользователя ${item.name}`} onClick={(event) => { event.stopPropagation(); openEditUser(item); }}><MaterialIcon name="edit" /></button></td></tr>)}</tbody></table></div>
            <footer className="compact-table-footer"><Pagination page={userPagination.page} pageCount={userPagination.pageCount} pageSize={6} totalItems={userRows.length} itemLabel="пользователей" onPageChange={userPagination.setPage} /></footer>
          </section>}

        {tab === "settings" && !settingsLoaded && <p role="status">Загрузка настроек…</p>}
        {tab === "settings" && settingsLoaded && <div className="admin-settings-workspace">
          <section className="system-settings-card admin-settings-card" aria-labelledby="department-settings-heading">
            <header><div><MaterialIcon name="apartment" /><div><h2 id="department-settings-heading">Настройки подразделения</h2><p>Для подразделения, выбранного в шапке</p></div></div></header>
            <div className="settings-form">
              <label><span>Часовой регион подразделения</span><select value={timezone} onChange={event => setTimezone(event.target.value)}>{!regionTimezones.some(([zone]) => zone === timezone) && <option value={timezone}>{timezone}</option>}{regionTimezones.map(([zone, label]) => <option key={zone} value={zone}>{label}</option>)}</select></label>
              <label><span>Адрес офиса подразделения</span><input value={officeAddress} onChange={event => setOfficeAddress(event.target.value)} placeholder="Город, улица, дом" /><small>Старт маршрута для исполнителей без собственного адреса. Координаты определяются при сохранении.</small></label>
            </div>
            <footer><button type="button" disabled={savingSettings.department} onClick={() => { setTimezone(savedSettings.timezone); setOfficeAddress(savedSettings.officeAddress); }}>Отмена</button><button className="save-settings" type="button" disabled={savingSettings.department} onClick={() => saveSettings("department")}>{savingSettings.department ? "Сохранение…" : "Сохранить"}</button></footer>
          </section>
          <section className="system-settings-card admin-settings-card" aria-labelledby="planning-settings-heading">
            <header><div><MaterialIcon name="route" /><div><h2 id="planning-settings-heading">Настройки планирования</h2><p>Общие настройки для всех подразделений</p></div></div></header>
            <div className="settings-form">
                <label><span>Алгоритм распределения</span><select value={optimizationEngine} onChange={(event) => { if (isOptimizationEngineId(event.target.value)) { setOptimizationEngine(event.target.value); if (event.target.value === "two_gis_tsp") setTravelMatrixProvider("two_gis"); } }}>{OPTIMIZATION_ENGINE_OPTIONS.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}</select><small>{OPTIMIZATION_ENGINE_OPTIONS.find((option) => option.id === optimizationEngine)?.description}</small></label>
                {["ortools", "pyvrp"].includes(optimizationEngine) && <label><span>Приоритет аварий и штата</span><select value={optimizerPolicy} onChange={event => { if (isOptimizerPolicy(event.target.value)) setOptimizerPolicy(event.target.value); }}>{OPTIMIZER_POLICY_OPTIONS.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}</select><small>{OPTIMIZER_POLICY_OPTIONS.find(option => option.id === optimizerPolicy)?.description}</small></label>}
                <label><span>Источник времени и расстояний</span><select value={travelMatrixProvider} disabled={optimizationEngine === "two_gis_tsp"} onChange={(event) => { if (isTravelMatrixProviderId(event.target.value)) setTravelMatrixProvider(event.target.value); }}>{TRAVEL_MATRIX_PROVIDER_OPTIONS.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}</select><small>{TRAVEL_MATRIX_PROVIDER_OPTIONS.find((option) => option.id === travelMatrixProvider)?.description}</small></label>
                {optimizationEngine === "two_gis_tsp" && <p className="planning-settings-note">TSP API рассчитывает свою матрицу 2ГИС. Чтобы выбрать OSRM, выберите PyVRP или OR-Tools. Эти методы также поддерживают смешанные виды транспорта.</p>}
                {travelMatrixProvider === "osrm" && <p className="planning-travel-warning" role="status"><MaterialIcon name="warning" /><span>{OSRM_TRAVEL_WARNING}</span></p>}
                <label><span>Максимальное время расчёта, с</span><input type="number" min={30} max={1800} step={1} value={calculationTimeoutSeconds} onChange={event => setCalculationTimeoutSeconds(event.target.value)} /><small>От 30 до 1800 секунд. Общий лимит на получение дорожных данных и расчёт всех подразделений. По истечении лимита прежний черновик сохраняется.</small></label>
                <p className="planning-settings-note">После сохранения нажмите «Пересчитать» на экране планирования. Изменения заявок вступят в силу после публикации плана.</p>
            </div>
            <footer><button type="button" disabled={savingSettings.planning} onClick={() => { setCalculationTimeoutSeconds(String(savedSettings.calculationTimeoutSeconds ?? DEFAULT_CALCULATION_TIMEOUT_SECONDS)); setOptimizationEngine(savedSettings.optimizationEngine); setOptimizerPolicy(savedSettings.optimizerPolicy ?? DEFAULT_OPTIMIZER_POLICY); setTravelMatrixProvider(savedSettings.travelMatrixProvider); }}>Отмена</button><button className="save-settings" type="button" disabled={savingSettings.planning} onClick={() => saveSettings("planning")}>{savingSettings.planning ? "Сохранение…" : "Сохранить"}</button></footer>
          </section><WorkSchedulesPanel schedules={workSchedules} onCreate={() => setWorkScheduleEditor({ mode: "create" })} onEdit={(schedule) => setWorkScheduleEditor({ mode: "edit", schedule })} /></div>}

        {tab === "roles" && <RolesPanel roles={roles} users={displayedRoleUsers} selectedRoleId={selectedRoleId} onSelectRole={setSelectedRoleId} onTogglePermission={togglePermission} onToggleUser={toggleRoleUser} onSave={saveRoleChanges} />}
        {categoryEditor && <CategoryEditor initialCategory={categoryEditor.category} equipmentOnly={categoryEditor.equipmentOnly} equipment={equipmentItems} onClose={()=>setCategoryEditor(null)} onCategorySaved={item=>setWorkCategories(current=>[...current.filter(c=>c.id!==item.id),item])} onEquipmentSaved={item=>{setEquipmentItems(current=>[...current.filter(e=>e.id!==item.id),item]);setWorkCategories(current=>current.map(c=>({...c,equipment:c.equipment?.map(e=>e.equipmentId===item.id ? {...e,name:item.name,unit:item.unit,usage:item.usage}:e)})));}} />}
        {tab === "catalog" && <><WorkTypesPanel workTypes={workTypes} categories={workCategories} onCategoryEdit={(category,equipmentOnly)=>setCategoryEditor({category,equipmentOnly})} onCreate={categoryId => setWorkTypeEditor({ mode: "create", categoryId })} onEdit={workType => setWorkTypeEditor({ mode: "edit", workType })} /></>}
      </main>
      {userEditor && <UserEditor initialUser={userEditor.mode === "edit" ? userEditor.user : null} roles={roles} onClose={() => setUserEditor(null)} onSave={saveUser} />}
      {workTypeEditor && <WorkTypeEditor workCategories={workCategories} equipmentItems={equipmentItems} initialWorkType={workTypeEditor.mode === "edit" ? workTypeEditor.workType : null} initialCategoryId={workTypeEditor.mode === "create" ? workTypeEditor.categoryId : undefined} onClose={() => setWorkTypeEditor(null)} onSave={saveWorkType} />}
      {workScheduleEditor && <WorkScheduleEditor initialSchedule={workScheduleEditor.mode === "edit" ? workScheduleEditor.schedule : null} onClose={() => setWorkScheduleEditor(null)} onSave={saveWorkSchedule} />}
      {roleChangeQueue[0] && <RoleChangeDialog userName={roleChangeQueue[0].userName} fromRole={roleLabels[roleChangeQueue[0].fromRoleId]} toRole={roleLabels[roleChangeQueue[0].toRoleId]} current={roleChangeTotal - roleChangeQueue.length + 1} total={roleChangeTotal} onApprove={() => resolveCurrentRoleChange(true)} onReject={() => resolveCurrentRoleChange(false)} />}
      {notice && <div className="resource-notice" role="status">{notice}</div>}
    </DispatcherSectionShell>
  );
}
