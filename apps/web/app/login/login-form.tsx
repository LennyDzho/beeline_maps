"use client";

import { FormEvent, useRef, useState } from "react";
import MaterialIcon from "@/app/components/material-icon";

export default function LoginForm() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submittingRef.current) return;
    submittingRef.current = true;
    setError("");
    setSubmitting(true);
    let navigating = false;

    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const payload = (await response.json()) as { message?: string };

      if (!response.ok) {
        setError(payload.message || "Не удалось выполнить вход.");
        return;
      }

      // A full document navigation reads the new HttpOnly cookie. Replace the
      // login history entry, and keep the form locked until that navigation ends.
      window.location.replace("/");
      navigating = true;
    } catch {
      setError("Нет связи с сервером. Попробуйте ещё раз.");
    } finally {
      if (!navigating) {
        submittingRef.current = false;
        setSubmitting(false);
      }
    }
  }

  return (
    <form className="login-form" onSubmit={handleSubmit}>
      <header className="login-heading">
        <span className="login-logo"><MaterialIcon name="route" /></span>
        <h1>Марш!</h1>
        <strong>Диспетчерская</strong>
      </header>

      <div className="login-copy">
        <h2>Вход в систему</h2>
        <p>Введите рабочий email и пароль, выданные администратором.</p>
      </div>

      <label className="field-label">
        <span>Email</span>
        <span className="login-input-wrap">
          <MaterialIcon name="mail" />
          <input
            type="email"
            autoComplete="username"
            inputMode="email"
            placeholder="dispatcher@company.ru"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            disabled={submitting}
            required
          />
        </span>
      </label>

      <label className="field-label">
        <span>Пароль</span>
        <span className="login-input-wrap password-field">
          <MaterialIcon name="lock" />
          <input
            type={showPassword ? "text" : "password"}
            autoComplete="current-password"
            placeholder="••••••••"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            disabled={submitting}
            minLength={8}
            maxLength={128}
            required
          />
          <button type="button" onClick={() => setShowPassword((value) => !value)} aria-label={showPassword ? "Скрыть пароль" : "Показать пароль"}>
            <MaterialIcon name={showPassword ? "visibility_off" : "visibility"} />
          </button>
        </span>
      </label>

      {error && <div className="login-error" role="alert">{error}</div>}

      <button className="login-submit" type="submit" disabled={submitting}>
        {submitting ? "Проверяем…" : "Войти"}
        {!submitting && <MaterialIcon name="arrow_forward" />}
      </button>

      <p className="login-help">Нет доступа? <span>Обратитесь к администратору проекта.</span></p>
    </form>
  );
}
