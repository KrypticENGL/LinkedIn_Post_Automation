/** Mirrors src/db/schema.ts DRAFT_STATUSES so this UI lines up with the bot's real states. */
export type DraftStatus =
  | "topic_selected"
  | "generating"
  | "moderating"
  | "moderation_blocked"
  | "pending_review"
  | "awaiting_confirmation"
  | "awaiting_feedback"
  | "publishing"
  | "posted"
  | "cancelled"
  | "failed";

export type PostSummary = {
  id: string;
  title: string;
  snippet: string;
  status: DraftStatus;
  model: string;
  revisionCount: number;
  createdAt: string;
};

/** Mirrors src/health.ts ModelQuota. */
export type ModelQuota = {
  model: string;
  role: "primary" | "fallback";
  usedToday: number;
  usedThisMinute: number;
  perDay: number;
  perMinute: number;
};

export type QuotaReport = {
  status: "ok" | "warn" | "down";
  models: ModelQuota[];
  resetsInMs: number;
  timeZone: string;
};
