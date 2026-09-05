import { motion } from "framer-motion";
import { useEffect, useState } from "react";
import { MOCK_QUOTA } from "../data/mock";
import styles from "./Quota.module.css";

function formatDuration(ms: number): string {
  const totalMinutes = Math.max(0, Math.floor(ms / 60_000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes}m`;
  return `${hours}h ${minutes}m`;
}

const STATUS_COPY = {
  ok: { label: "All systems go", tone: "ok" },
  warn: { label: "Up, with warnings", tone: "warn" },
  down: { label: "Something is down", tone: "down" },
} as const;

export function Quota() {
  const [resetsIn, setResetsIn] = useState(MOCK_QUOTA.resetsInMs);

  useEffect(() => {
    const id = setInterval(() => setResetsIn((ms) => Math.max(0, ms - 1000)), 1000);
    return () => clearInterval(id);
  }, []);

  const statusCopy = STATUS_COPY[MOCK_QUOTA.status];

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <div className={styles.headerTop}>
          <h1 className={styles.title}>Quota</h1>
          <span className={`${styles.status} ${styles[statusCopy.tone]}`}>{statusCopy.label}</span>
        </div>
        <p className={styles.subtitle}>
          Counted from calls this bot recorded against <code>GEMINI_FREE_RPD</code>/<code>RPM</code> — Google
          publishes no quota endpoint, so treat it as a floor, not a guarantee.
        </p>
      </div>

      <div className={styles.cards}>
        {MOCK_QUOTA.models.map((m, i) => {
          const dayPct = Math.min(100, (m.usedToday / m.perDay) * 100);
          const minutePct = Math.min(100, (m.usedThisMinute / m.perMinute) * 100);
          const dayLeft = Math.max(0, m.perDay - m.usedToday);
          const minuteLeft = Math.max(0, m.perMinute - m.usedThisMinute);

          return (
            <motion.div
              key={m.model}
              className={styles.card}
              initial={{ opacity: 0, y: 14 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.4, delay: i * 0.08, ease: [0.16, 1, 0.3, 1] }}
            >
              <div className={styles.cardTop}>
                <span className={styles.model}>{m.model}</span>
                <span className={`${styles.role} ${m.role === "primary" ? styles.rolePrimary : ""}`}>{m.role}</span>
              </div>

              <div className={styles.metric}>
                <div className={styles.metricLabel}>
                  <span>Today</span>
                  <span>
                    <b>{dayLeft.toLocaleString()}</b> of {m.perDay.toLocaleString()} left
                  </span>
                </div>
                <div className={styles.bar}>
                  <motion.div
                    className={styles.barFill}
                    initial={{ width: 0 }}
                    animate={{ width: `${dayPct}%` }}
                    transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
                  />
                </div>
              </div>

              <div className={styles.metric}>
                <div className={styles.metricLabel}>
                  <span>This minute</span>
                  <span>
                    <b>{minuteLeft}</b> of {m.perMinute} left
                  </span>
                </div>
                <div className={styles.bar}>
                  <motion.div
                    className={styles.barFill}
                    initial={{ width: 0 }}
                    animate={{ width: `${minutePct}%` }}
                    transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
                  />
                </div>
              </div>
            </motion.div>
          );
        })}
      </div>

      <div className={styles.footer}>
        Resets in <b>{formatDuration(resetsIn)}</b> · midnight {MOCK_QUOTA.timeZone}
      </div>
    </div>
  );
}
