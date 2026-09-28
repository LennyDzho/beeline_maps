"use client";

import { useEffect } from "react";
import MaterialIcon from "@/app/components/material-icon";

type RoleChangeDialogProps = {
  userName: string;
  fromRole: string;
  toRole: string;
  current: number;
  total: number;
  onApprove: () => void;
  onReject: () => void;
};

export default function RoleChangeDialog({ userName, fromRole, toRole, current, total, onApprove, onReject }: RoleChangeDialogProps) {
  useEffect(() => {
    const rejectOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onReject();
    };
    window.addEventListener("keydown", rejectOnEscape);
    return () => window.removeEventListener("keydown", rejectOnEscape);
  }, [onReject]);

  return (
    <div className="role-change-backdrop" role="presentation">
      <section className="role-change-dialog" role="dialog" aria-modal="true" aria-labelledby="role-change-title" aria-describedby="role-change-description">
        <header><span><MaterialIcon name="swap_horiz" /></span><div><h2 id="role-change-title">Подтверждение смены роли</h2><p>Проверка {current} из {total}</p></div></header>
        <div className="role-change-content">
          <p id="role-change-description"><strong>{userName}</strong> уже относится к роли «{fromRole}».</p>
          <div><span>{fromRole}</span><MaterialIcon name="arrow_forward" /><span>{toRole}</span></div>
          <p>Применить новую роль для этого пользователя?</p>
        </div>
        <footer><button className="request-cancel-button" type="button" onClick={onReject}>Нет</button><button className="stitch-green-button" type="button" onClick={onApprove}><MaterialIcon name="check" />Да, применить</button></footer>
      </section>
    </div>
  );
}
