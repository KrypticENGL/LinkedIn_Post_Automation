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

/**
 * One command-and-reply pair in the New Post composer's transcript. Lifted to
 * App.tsx (see ComposerState there) rather than living in NewPost's own state, so it
 * survives switching to Previous Posts/Quota and back — React Router unmounts the
 * page on every route change, which would otherwise wipe it.
 */
export type ComposerEntry = {
  id: string;
  command: string;
  html: string;
  url?: string;
  tone: "success" | "error" | "info";
};
