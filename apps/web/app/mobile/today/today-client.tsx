"use client";

import { useState } from "react";
import MaterialIcon from "@/app/components/material-icon";
import MobileNav from "../mobile-nav";

const schedule = [
  { time: "08:00 - 09:30", id: "A-1425", title: "Замена счетчика", address: "ул. Ленина, 45", done: true },
  { time: "13:00 - 14:30", id: "A-1430", title: "Ремонт кондиционера", address: "пр. Мира, 102", done: false },
  { time: "15:00 - 17:00", id: "A-1435", title: "Плановое ТО", address: "ул. Гагарина, 8", done: false },
];

export default function TodayClient() {
  const [departing, setDeparting] = useState(false);

  return (
    <main className="mobile-screen mobile-today-screen">
      <div className="mobile-content">
        <header className="today-header">
          <div><h1>Добрый день, Алексей</h1><p>20 августа</p></div>
          <span className="shift-badge"><i />В смене</span>
        </header>

        <div className="today-summary">
          <strong>Заявок на сегодня: 6</strong>
          <span><MaterialIcon name="cloud_sync" /> Синхронизировано</span>
        </div>

        <section className="next-visit-section">
          <h2>Следующий визит</h2>
          <article className="next-visit-card">
            <div className="next-visit-line">
              <span>A-1428</span>
              <time>10:00 - 12:00</time>
            </div>
            <h3>Диагностика оборудования</h3>
            <div className="mobile-address">
              <MaterialIcon name="location_on" />
              <span>ул. Академика Королёва, 12<small>Подъезд 1, этаж 3</small></span>
            </div>
            <div className="next-visit-actions">
              <a href="/mobile/visits/A-1428">Детали</a>
              <button type="button" onClick={() => setDeparting(true)}>
                <MaterialIcon name="directions_car" filled />
                {departing ? "В пути" : "Выехать"}
              </button>
            </div>
          </article>
        </section>

        <section className="schedule-section">
          <h2>Расписание</h2>
          <div className="schedule-timeline">
            {schedule.map((item) => (
              <article className={item.done ? "done" : ""} key={item.id}>
                <span className="timeline-dot">{item.done ? <MaterialIcon name="check" /> : null}</span>
                <div className="schedule-card">
                  <div><time>{item.time}</time><span>{item.id}</span></div>
                  <strong>{item.title}</strong>
                  <p>{item.address}</p>
                </div>
              </article>
            ))}
          </div>
        </section>
      </div>

      <MobileNav active="today" />
    </main>
  );
}
