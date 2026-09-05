import { sql } from "drizzle-orm";
import { boolean, index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * Draft lifecycle
 *
 *   topic_selected
 *        v
 *   generating -> moderating -> pending_review ---(approve)--> awaiting_confirmation
 *                     |               ^                              |
 *              (unsafe, retries       |                       (confirm) v
 *               exhausted) v          |                          publishing -> posted
 *                  moderation_blocked |                              |
 *                                     |                          (error) v
 *                     (reject -> request changes)                   failed
 *                                     |
 *                            awaiting_feedback --(user replies)--> generating ...
 *                                     |
 *                                (cancel) v
 *                                    cancelled
 */
export const DRAFT_STATUSES = [
  "topic_selected",
  "generating",
  "moderating",
  "moderation_blocked",
  "pending_review",
  "awaiting_confirmation",
  "awaiting_feedback",
  "publishing",
  "posted",
  "cancelled",
  "failed",
] as const;

export type DraftStatus = (typeof DRAFT_STATUSES)[number];

/** Which part of the draft the user asked to change. */
export const REVISION_SCOPES = ["text", "image", "both"] as const;
export type RevisionScope = (typeof REVISION_SCOPES)[number];

export type TopicCandidate = {
  title: string;
  angle: string;
  whyNow: string;
  sources: { title: string; url: string; publisher?: string }[];
};

export type ModerationReport = {
  safe: boolean;
  checkedAt: string;
  text: {
    safe: boolean;
    categories: string[];
    reason: string;
  };
  image: {
    safe: boolean;
    categories: string[];
    reason: string;
  } | null;
};

export type FeedbackEntry = {
  at: string;
  scope: RevisionScope;
  note: string;
};

export const topicBatches = pgTable(
  "topic_batches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** "open" while the buttons are live, "used" once a topic was picked, "expired" when superseded. */
    status: text("status").notNull().default("open"),
    topics: jsonb("topics").$type<TopicCandidate[]>().notNull(),
    telegramMessageId: integer("telegram_message_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("topic_batches_status_idx").on(table.status)],
);

export const drafts = pgTable(
  "drafts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    topicBatchId: uuid("topic_batch_id").references(() => topicBatches.id, { onDelete: "set null" }),

    topicTitle: text("topic_title").notNull(),
    topicAngle: text("topic_angle").notNull().default(""),
    topicWhyNow: text("topic_why_now").notNull().default(""),
    topicSources: jsonb("topic_sources").$type<TopicCandidate["sources"]>().notNull().default(sql`'[]'::jsonb`),

    postText: text("post_text"),
    imagePrompt: text("image_prompt"),
    imageAltText: text("image_alt_text"),
    /** Path on disk, relative to the process working directory. */
    imagePath: text("image_path"),

    status: text("status").$type<DraftStatus>().notNull().default("topic_selected"),
    revisionCount: integer("revision_count").notNull().default(0),
    moderationAttempts: integer("moderation_attempts").notNull().default(0),

    moderation: jsonb("moderation").$type<ModerationReport | null>(),
    feedbackHistory: jsonb("feedback_history").$type<FeedbackEntry[]>().notNull().default(sql`'[]'::jsonb`),

    linkedinPostId: text("linkedin_post_id"),
    telegramReviewMessageId: integer("telegram_review_message_id"),
    telegramPhotoMessageId: integer("telegram_photo_message_id"),

    errorMessage: text("error_message"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("drafts_status_idx").on(table.status),
    index("drafts_created_at_idx").on(table.createdAt),
  ],
);

export const linkedinTokens = pgTable("linkedin_tokens", {
  id: uuid("id").primaryKey().defaultRandom(),
  /** urn:li:person:<sub> resolved from the OpenID Connect userinfo endpoint. */
  memberUrn: text("member_urn").notNull(),
  /** AES-256-GCM ciphertext, never plaintext. */
  accessToken: text("access_token").notNull(),
  refreshToken: text("refresh_token"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  refreshExpiresAt: timestamp("refresh_expires_at", { withTimezone: true }),
  scope: text("scope").notNull().default(""),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Telegram conversation state, persisted so an in-flight "reply with your
 * changes" prompt survives a restart or a Render cold start.
 */
/**
 * Single-row table (id is always "global") holding runtime overrides that would
 * otherwise need an env var change and a redeploy — currently just which Gemini
 * model to call. Null means "use the env default".
 */
export const botSettings = pgTable("bot_settings", {
  id: text("id").primaryKey().default("global"),
  geminiModel: text("gemini_model"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const conversationState = pgTable("conversation_state", {
  chatId: text("chat_id").primaryKey(),
  awaitingFeedbackDraftId: uuid("awaiting_feedback_draft_id").references(() => drafts.id, {
    onDelete: "cascade",
  }),
  awaitingFeedbackScope: text("awaiting_feedback_scope").$type<RevisionScope>(),
  awaitingCustomTopicBatchId: uuid("awaiting_custom_topic_batch_id").references(() => topicBatches.id, {
    onDelete: "cascade",
  }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * One row per Gemini call, written from the token counts the API returns. Persisted
 * rather than counted in memory so the figures survive a restart or a Render cold
 * start, which would otherwise reset them every few hours.
 */
export const apiUsage = pgTable(
  "api_usage",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** The `label` passed to structured(), e.g. "topic-curation". */
    label: text("label").notNull(),
    model: text("model").notNull(),
    promptTokens: integer("prompt_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    totalTokens: integer("total_tokens").notNull().default(0),
    /** Thinking tokens, billed as output and reported separately by Gemini. */
    thoughtTokens: integer("thought_tokens").notNull().default(0),
    /** False when the call was refused or errored — still consumes quota. */
    ok: boolean("ok").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("api_usage_created_at_idx").on(table.createdAt)],
);

export type Draft = typeof drafts.$inferSelect;
export type TopicBatch = typeof topicBatches.$inferSelect;
export type LinkedinTokenRow = typeof linkedinTokens.$inferSelect;
export type ApiUsageRow = typeof apiUsage.$inferSelect;
