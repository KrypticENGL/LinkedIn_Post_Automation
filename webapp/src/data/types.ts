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

/** Which backend answers the AI calls — see src/ai/modalProxy.ts. */
export type AiService = "Modal" | "Google AI Studio";

/** Matches GET/POST /api/model. */
export type ModelInfo = {
  active: string | null;
  default: string;
  fallback: string;
  /** True when MODAL_AI_URL is configured: calls go to Modal, then Google as fallback. */
  modalEnabled: boolean;
  /** Best guess at which service is serving right now ("Google AI Studio" during
   *  Modal's post-failure cooldown). */
  activeService: AiService;
};

/**
 * One line in the New Post composer's transcript — either a command the user ran
 * and its reply (`command` set), or a message the bot pushed on its own that the
 * server teed to GET /api/activity (`command` absent). Lifted to App.tsx rather
 * than NewPost's own state so it survives switching to Previous Posts/Quota and
 * back — React Router unmounts the page on every route change.
 */
export type ComposerEntry = {
  id: string;
  command?: string;
  html: string;
  url?: string;
  tone: "success" | "error" | "info";
};

/** Matches GET /api/posts/latest — the full text of the most recent draft, for the
 *  preview editor to load and tweak. */
export type LatestDraft = {
  id: string;
  title: string;
  postText: string;
  status: DraftStatus;
  createdAt: string;
};

/** Matches GET /api/activity — bot→approver messages, newest last. */
export type ActivityEvent = {
  id: number;
  at: string;
  html: string;
  tone: "success" | "error" | "info";
  url?: string;
};

/* -------------------------------------------------------------------- review */

export type RevisionScope = "text" | "image" | "both";

/** Mirrors src/db/schema.ts ModerationReport. */
export type ModerationReport = {
  safe: boolean;
  checkedAt: string;
  text: { safe: boolean; categories: string[]; reason: string };
  image: { safe: boolean; categories: string[]; reason: string } | null;
};

export type FeedbackEntry = { at: string; scope: RevisionScope; note: string };

/** One topic offered for selection — mirrors src/db/schema.ts TopicCandidate. */
export type ReviewTopic = {
  title: string;
  angle: string;
  whyNow: string;
  sources: { title: string; url: string; publisher?: string }[];
};

/** The batch whose pick-a-topic buttons are live, from GET /api/review. */
export type ReviewTopicBatch = {
  id: string;
  topics: ReviewTopic[];
  createdAt: string;
};

/** The draft the review page is currently about, from GET /api/review. */
export type ReviewDraft = {
  id: string;
  topicTitle: string;
  postText: string;
  status: DraftStatus;
  revisionCount: number;
  maxRevisions: number;
  moderation: ModerationReport | null;
  hasImage: boolean;
  /** Full URL (already `/api/...`) — fetch it with the Telegram auth header. */
  imageUrl: string | null;
  imageAltText: string | null;
  feedbackHistory: FeedbackEntry[];
  errorMessage: string | null;
  updatedAt: string;
};

/** GET /api/review. */
export type ReviewState = {
  topicBatch: ReviewTopicBatch | null;
  draft: ReviewDraft | null;
};
