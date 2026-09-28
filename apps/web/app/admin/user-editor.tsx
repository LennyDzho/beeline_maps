"use client";

import { useEffect, useState, type FormEvent } from "react";
import MaterialIcon from "@/app/components/material-icon";
import type { SystemRole, SystemRoleId } from "./role-data";
import type { SystemUser, SystemUserStatus } from "./user-data";

type UserDraft = Omit<SystemUser, "roleId" | "status"> & {
  roleId: SystemRoleId | "";
  status: SystemUserStatus | "";
};

export type UserSavePayload = {
  user: SystemUser;
  password: string;
  requirePasswordChange: boolean;
};

const emptyDraft: UserDraft = {
  id: "",
  initials: "",
  name: "",
  email: "",
  roleId: "",
  status: "active",
  statusLabel: "Активен",
  activity: "Ещё не входил",
};

const statusLabels: Record<SystemUserStatus, string> = {
  active: "Активен",
  offline: "Не в сети",
  blocked: "Заблокирован",
};

type UserEditorProps = {
  initialUser: SystemUser | null;
  roles: SystemRole[];
  onClose: () => void;
  onSave: (payload: UserSavePayload) => void | Promise<void>;
};

export default function UserEditor({ initialUser, roles, onClose, onSave }: UserEditorProps) {
  const [draft, setDraft] = useState<UserDraft>(initialUser ? { ...initialUser, roleId: initialUser.roleId ?? "" } : emptyDraft);
  const [password, setPassword] = useState("");
  const [requirePasswordChange, setRequirePasswordChange] = useState(!initialUser);
  const editing = initialUser !== null;

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [onClose]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft.roleId || !draft.status) return;
    onSave({
      user: {
        ...draft,
        name: draft.name.trim(),
        email: draft.email.trim().toLowerCase(),
        initials: getInitials(draft.name),
        roleId: draft.roleId,
        status: draft.status,
        statusLabel: statusLabels[draft.status],
      },
      password,
      requirePasswordChange,
    });
  }

  return (
    <div className="request-editor-backdrop user-editor-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="request-editor user-editor" role="dialog" aria-modal="true" aria-labelledby="user-editor-title">
        <form onSubmit={submit}>
          <header>
            <div><span className="request-editor-icon"><MaterialIcon name={editing ? "manage_accounts" : "person_add"} /></span><div><h2 id="user-editor-title">{editing ? "Редактирование пользователя" : "Новый пользователь"}</h2><p>{editing ? `#${initialUser.id}` : "Учётная запись для доступа в систему"}</p></div></div>
            <button type="button" aria-label="Закрыть форму" onClick={onClose}><MaterialIcon name="close" /></button>
          </header>

          <div className="user-editor-fields">
            <section>
              <h3><MaterialIcon name="account_circle" />Учётная запись</h3>
              <div className="user-editor-grid">
                <label><span>Идентификатор</span><input value={draft.id} placeholder="Будет присвоен автоматически" readOnly /></label>
                <label><span>ФИО *</span><input value={draft.name} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} placeholder="Иванов Иван Иванович" required /></label>
                <label className="full-field"><span>Email *</span><input type="email" value={draft.email} onChange={(event) => setDraft((current) => ({ ...current, email: event.target.value }))} placeholder="user@route.ru" required /></label>
                <label><span>Роль *</span><select value={draft.roleId} onChange={(event) => setDraft((current) => ({ ...current, roleId: event.target.value as SystemRoleId }))} required><option value="" disabled>Выберите роль</option>{roles.map((role) => <option value={role.id} key={role.id}>{role.name}</option>)}</select></label>
                <label><span>Статус *</span><select value={draft.status} onChange={(event) => setDraft((current) => ({ ...current, status: event.target.value as SystemUserStatus }))} required><option value="active">Активен</option><option value="offline">Не в сети</option><option value="blocked">Заблокирован</option></select></label>
              </div>
            </section>

            <section>
              <h3><MaterialIcon name="shield_lock" />Безопасность</h3>
              <div className="user-editor-grid">
                <label className="full-field"><span>{editing ? "Новый пароль" : "Временный пароль *"}</span><input type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder={editing ? "Оставьте пустым, чтобы не менять" : "Не менее 8 символов"} minLength={8} required={!editing} autoComplete="new-password" /></label>
                <div className="user-password-check full-field"><input id="require-password-change" type="checkbox" checked={requirePasswordChange} onChange={(event) => setRequirePasswordChange(event.target.checked)} /><label htmlFor="require-password-change"><b>Сменить пароль при входе</b><small>Пользователь задаст собственный пароль после авторизации</small></label></div>
              </div>
            </section>
          </div>

          <footer><button className="request-cancel-button" type="button" onClick={onClose}>Отмена</button><button className="stitch-green-button" type="submit"><MaterialIcon name="save" />{editing ? "Сохранить изменения" : "Создать пользователя"}</button></footer>
        </form>
      </section>
    </div>
  );
}

function getInitials(name: string) {
  return name.trim().split(/\s+/u).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join("") || "П";
}
