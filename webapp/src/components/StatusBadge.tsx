import type { DraftStatus } from "../data/types";
import styles from "./StatusBadge.module.css";

const CONFIG: Record<DraftStatus, { label: string; tone: "ok" | "warn" | "down" | "neutral" }> = {
  topic_selected: { label: "Queued", tone: "neutral" },
  generating: { label: "Generating", tone: "warn" },
  moderating: { label: "Moderating", tone: "warn" },
  moderation_blocked: { label: "Blocked", tone: "down" },
  pending_review: { label: "Awaiting review", tone: "warn" },
  awaiting_confirmation: { label: "Awaiting confirmation", tone: "warn" },
  awaiting_feedback: { label: "Awaiting feedback", tone: "warn" },
  publishing: { label: "Publishing", tone: "warn" },
  posted: { label: "Posted", tone: "ok" },
  cancelled: { label: "Cancelled", tone: "neutral" },
  failed: { label: "Failed", tone: "down" },
};

export function StatusBadge({ status }: { status: DraftStatus }) {
  const { label, tone } = CONFIG[status];
  return <span className={`${styles.badge} ${styles[tone]}`}>{label}</span>;
}
