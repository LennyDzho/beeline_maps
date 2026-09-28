"use client";

import MaterialIcon from "@/app/components/material-icon";
import type { SystemUser } from "./user-data";
import { permissionCatalog, type PermissionId, type SystemRole, type SystemRoleId } from "./role-data";

type RolesPanelProps = {
  roles: SystemRole[];
  users: SystemUser[];
  selectedRoleId: SystemRoleId;
  onSelectRole: (roleId: SystemRoleId) => void;
  onTogglePermission: (permissionId: PermissionId) => void;
  onToggleUser: (userId: string) => void;
  onSave: () => void;
};

export default function RolesPanel({ roles, users, selectedRoleId, onSelectRole, onTogglePermission, onToggleUser, onSave }: RolesPanelProps) {
  const selectedRole = roles.find((role) => role.id === selectedRoleId) ?? roles[0]!;
  const assignedCount = users.filter((user) => user.roleId === selectedRole.id).length;

  return (
    <section className="roles-workspace" aria-label="Управление ролями и правами">
      <aside className="roles-list-card">
        <header><div><MaterialIcon name="shield_person" /><div><h2>Роли</h2><p>Выберите роль для настройки</p></div></div></header>
        <div className="roles-list">
          {roles.map((role) => <button className={role.id === selectedRole.id ? "active" : ""} type="button" onClick={() => onSelectRole(role.id)} key={role.id}><span><MaterialIcon name={role.icon} /></span><div><strong>{role.name}</strong><small>{users.filter((user) => user.roleId === role.id).length} польз.</small></div><MaterialIcon name="chevron_right" /></button>)}
        </div>
      </aside>

      <section className="role-editor-card">
        <header><div><span><MaterialIcon name={selectedRole.icon} /></span><div><h2>{selectedRole.name}</h2><p>{selectedRole.description}</p></div></div><b>{assignedCount} пользователей</b></header>

        <div className="role-editor-content">
          <section className="role-editor-section">
            <div className="role-section-heading"><div><h3>Права доступа</h3><p>Отметьте действия, доступные пользователям этой роли.</p></div><span>{selectedRole.permissions.length} из {permissionCatalog.length}</span></div>
            <div className="permissions-grid">
              {permissionCatalog.map((permission) => <label className={selectedRole.permissions.includes(permission.id) ? "checked" : ""} aria-label={permission.label} key={permission.id}><input type="checkbox" aria-label={permission.label} checked={selectedRole.permissions.includes(permission.id)} onChange={() => onTogglePermission(permission.id)} /><span><b>{permission.label}</b><small>{permission.description}</small></span></label>)}
            </div>
          </section>

          <section className="role-editor-section">
            <div className="role-section-heading"><div><h3>Пользователи роли</h3><p>Галочка назначает пользователю выбранную роль. У пользователя может быть одна роль.</p></div><span>{assignedCount} назначено</span></div>
            <div className="role-users-grid">
              {users.map((user) => <label className={user.roleId === selectedRole.id ? "checked" : ""} aria-label={`Назначить роль пользователю ${user.name}`} key={user.id}><input type="checkbox" aria-label={`Назначить роль пользователю ${user.name}`} checked={user.roleId === selectedRole.id} onChange={() => onToggleUser(user.id)} /><span className="role-user-avatar">{user.initials}</span><span><b>{user.name}</b><small>{user.email}</small></span></label>)}
            </div>
          </section>
        </div>

        <footer><button className="stitch-green-button" type="button" onClick={onSave}><MaterialIcon name="save" />Сохранить изменения</button></footer>
      </section>
    </section>
  );
}
