import { motion } from "framer-motion";
import { useEffect, useState } from "react";
import type { QuotaReport } from "../data/types";
import { ApiError, getQuota } from "../lib/api";
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

type LoadState = "loading" | "ready" | "error";

export function Quota() {
  const [report, setReport] = useState<QuotaReport | null>(null);
  const [resetsIn, setResetsIn] = useState(0);
  const [state, setState] = useState<LoadState>("loading");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getQuota()
      .then((data) => {
        if (cancelled) return;
        setReport(data);
        setResetsIn(data.resetsInMs);
        setState("ready");
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof ApiError ? err.message : "Could not load quota");
        setState("error");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (state !== "ready") return;
    const id = setInterval(() => setResetsIn((ms) => Math.max(0, ms - 1000)), 1000);
    return () => clearInterval(id);
  }, [state]);

  if (state === "loading") {
    return (
      <div className={styles.page}>
        <p className={styles.loading}>Loading…</p>
      </div>
    );
  }

  if (state === "error" || !report) {
    return (
      <div className={styles.page}>
        <p className={styles.loadingError}>{error}</p>
      </div>
    );
  }

  const statusCopy = STATUS_COPY[report.status];

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

      {report.models.length === 0 && <p className={styles.loading}>No Gemini calls recorded yet.</p>}

      <div className={styles.cards}>
        {report.models.map((m, i) => {
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

      {report.models.length > 0 && (
        <div className={styles.footer}>
          Resets in <b>{formatDuration(resetsIn)}</b> · midnight {report.timeZone}
        </div>
      )}
    </div>
  );
}
