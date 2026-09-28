"use client";

import { useState, type FormEvent } from "react";
import MaterialIcon from "@/app/components/material-icon";
import { stitchMapUrl } from "@/app/dispatcher/data";

export default function VisitClient() {
  const [started, setStarted] = useState(false);
  const [completionOpen, setCompletionOpen] = useState(false);
  const [completed, setCompleted] = useState(false);
  const [reportText, setReportText] = useState("");
  const [attachments, setAttachments] = useState<Array<{ name: string; kind: "photo" | "video"; size: string }>>([]);
  const [fileError, setFileError] = useState("");

  function submitCompletion(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (attachments.length === 0) {
      setFileError("Добавьте хотя бы одно фото или видео.");
      return;
    }
    setCompleted(true);
    setCompletionOpen(false);
  }

  return (
    <main className="mobile-screen mobile-visit-screen">
      <header className="visit-topbar">
        <a href="/mobile/today" aria-label="Вернуться к расписанию"><MaterialIcon name="arrow_back" /></a>
        <h1>Заявка A-1428</h1>
      </header>

      <div className="visit-scroll-area">
        <section className="visit-intro">
          <span className="priority-badge"><MaterialIcon name="priority_high" />Высокий приоритет</span>
          <h2>Диагностика оборудования</h2>
          <div className="visit-map" style={{ backgroundImage: `url(${stitchMapUrl})` }}>
            <span><MaterialIcon name="location_on" filled /></span>
          </div>
          <div className="visit-address">
            <MaterialIcon name="location_on" filled />
            <p>ул. Академика Королёва, 12<small>Вход со двора, подъезд 3</small></p>
          </div>
          <a
            className="navigator-button"
            href="https://www.google.com/maps/search/?api=1&query=%D1%83%D0%BB.%20%D0%90%D0%BA%D0%B0%D0%B4%D0%B5%D0%BC%D0%B8%D0%BA%D0%B0%20%D0%9A%D0%BE%D1%80%D0%BE%D0%BB%D1%91%D0%B2%D0%B0%2C%2012%2C%20%D0%9C%D0%BE%D1%81%D0%BA%D0%B2%D0%B0"
            target="_blank"
            rel="noreferrer"
          >
            <MaterialIcon name="navigation" filled />Открыть в навигаторе
          </a>
        </section>

        <section className="visit-details">
          <h2>Детали визита</h2>
          <div className="visit-detail-grid">
            <article><MaterialIcon name="schedule" /><small>Окно прибытия</small><strong>10:00 - 12:00</strong></article>
            <article><MaterialIcon name="hourglass_empty" /><small>Оценка времени</small><strong>~ 2 ч.</strong></article>
          </div>
          <article className="competency-card">
            <span><MaterialIcon name="engineering" /></span>
            <div><small>Требуемая компетенция</small><strong>Электрика</strong></div>
          </article>

          <h2 className="progress-heading">Ход выполнения</h2>
          <div className="visit-progress">
            <div className="progress-item complete">
              <span><MaterialIcon name="check" /></span>
              <p>Назначено<small>Вчера, 18:45 • Диспетчер</small></p>
            </div>
            <div className="progress-item complete">
              <span><MaterialIcon name="check" /></span>
              <p>Заявка принята<small>Сегодня, 08:15 • Вами</small></p>
            </div>
            <div className={`progress-item ${started ? "complete" : ""}`}>
              <span>{started ? <MaterialIcon name="check" /> : null}</span>
              <p>{started ? "В работе" : "В работе"}{started ? <small>Сегодня • Вами</small> : null}</p>
            </div>
            <div className={`progress-item ${completed ? "complete" : ""}`}>
              <span>{completed ? <MaterialIcon name="check" /> : null}</span>
              <p>Завершено{completed ? <small>Отчёт отправлен диспетчеру</small> : null}</p>
            </div>
          </div>

          {completed && <article className="mobile-report-sent"><span><MaterialIcon name="task_alt" /></span><div><strong>Отчёт отправлен</strong><p>{reportText}</p><small>Прикреплено файлов: {attachments.length} · Ожидает подтверждения диспетчера</small></div></article>}
        </section>
      </div>

      <footer className="visit-actions">
        <button className="start-work-button" type="button" onClick={() => started ? setCompletionOpen(true) : setStarted(true)} disabled={completed}>
          {completed ? "Отчёт отправлен" : started ? "Завершить и отправить отчёт" : "Начать работу"}
        </button>
        <button className="report-problem-button" type="button">Сообщить о проблеме</button>
      </footer>

      {completionOpen && <div className="mobile-completion-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setCompletionOpen(false); }}>
        <section className="mobile-completion-sheet" role="dialog" aria-modal="true" aria-labelledby="mobile-completion-title">
          <form onSubmit={submitCompletion}>
            <header><div><h2 id="mobile-completion-title">Завершение работы</h2><p>Отчёт будет доступен диспетчеру в карточке заявки</p></div><button type="button" aria-label="Закрыть форму" onClick={() => setCompletionOpen(false)}><MaterialIcon name="close" /></button></header>
            <div className="mobile-completion-fields">
              <label><span>Комментарий о выполнении *</span><textarea value={reportText} onChange={(event) => setReportText(event.target.value)} placeholder="Что сделано, результат и замечания" rows={5} required /></label>
              <div className="mobile-attachment-field">
                <span>Фото и видео *</span>
                <label className="mobile-file-button"><MaterialIcon name="add_a_photo" /><b>Добавить материалы</b><small>Фото или видео с объекта</small><input type="file" accept="image/*,video/*" multiple onChange={(event) => { const files = Array.from(event.target.files ?? []); setAttachments(files.map((file) => ({ name: file.name, kind: file.type.startsWith("video/") ? "video" : "photo", size: formatFileSize(file.size) }))); setFileError(""); }} /></label>
                {attachments.length > 0 && <div className="mobile-attachment-list">{attachments.map((file) => <div key={`${file.name}-${file.size}`}><MaterialIcon name={file.kind === "video" ? "videocam" : "image"} /><span><strong>{file.name}</strong><small>{file.kind === "video" ? "Видео" : "Фото"} · {file.size}</small></span></div>)}</div>}
                {fileError && <p className="mobile-file-error" role="alert">{fileError}</p>}
              </div>
            </div>
            <footer><button type="button" onClick={() => setCompletionOpen(false)}>Отмена</button><button className="submit-completion-button" type="submit"><MaterialIcon name="send" />Отправить отчёт</button></footer>
          </form>
        </section>
      </div>}
    </main>
  );
}

function formatFileSize(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} КБ`;
  return `${(bytes / (1024 * 1024)).toFixed(1).replace(".", ",")} МБ`;
}
