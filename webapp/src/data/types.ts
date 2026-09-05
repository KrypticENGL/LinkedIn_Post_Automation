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

/** Matches GET /api/posts — no per-draft model, since the bot doesn't track one. */
export type PostSummary = {
  id: string;
  title: string;
  snippet: string;
  status: DraftStatus;
  revisionCount: number;
  createdAt: string;
};

/** Mirrors src/health.ts ModelQuota, returned by GET /api/quota. */
export type ModelQuota = {
  model: string;
  role: "primary" | "fallback";
  usedToday: number;
  usedThisMinute: number;
  perDay: number;
  perMinute: number;
};

/** Matches GET /api/quota. */
export type QuotaReport = {
  status: "ok" | "warn" | "down";
  models: ModelQuota[];
  resetsInMs: number;
  timeZone: string;
};

/** Matches GET/POST /api/model. */
export type ModelInfo = {
  active: string | null;
  default: string;
  fallback: string;
};
