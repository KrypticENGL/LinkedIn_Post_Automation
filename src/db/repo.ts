import { desc, eq, gte, inArray, sql } from "drizzle-orm";
import { db } from "./client.js";
import {
  apiUsage,
  conversationState,
  drafts,
  topicBatches,
  type Draft,
  type DraftStatus,
  type FeedbackEntry,
  type RevisionScope,
  type TopicBatch,
  type TopicCandidate,
} from "./schema.js";

/* ------------------------------------------------------------------ topics */

export async function createTopicBatch(topics: TopicCandidate[]): Promise<TopicBatch> {
  // Only one batch should own live buttons at a time.
  await db
    .update(topicBatches)
    .set({ status: "expired" })
    .where(eq(topicBatches.status, "open"));

  const [row] = await db.insert(topicBatches).values({ topics }).returning();
  if (!row) throw new Error("Failed to create topic batch");
  return row;
}

export async function getTopicBatch(id: string): Promise<TopicBatch | null> {
  const rows = await db.select().from(topicBatches).where(eq(topicBatches.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function setTopicBatchMessageId(id: string, messageId: number): Promise<void> {
  await db.update(topicBatches).set({ telegramMessageId: messageId }).where(eq(topicBatches.id, id));
}

export async function markTopicBatchUsed(id: string): Promise<void> {
  await db.update(topicBatches).set({ status: "used" }).where(eq(topicBatches.id, id));
}

/* ------------------------------------------------------------------ drafts */

export async function createDraft(input: {
  topicBatchId: string | null;
  topic: TopicCandidate;
}): Promise<Draft> {
  const [row] = await db
    .insert(drafts)
    .values({
      topicBatchId: input.topicBatchId,
      topicTitle: input.topic.title,
      topicAngle: input.topic.angle,
      topicWhyNow: input.topic.whyNow,
      topicSources: input.topic.sources,
      status: "topic_selected",
    })
    .returning();
  if (!row) throw new Error("Failed to create draft");
  return row;
}

export async function getDraft(id: string): Promise<Draft | null> {
  const rows = await db.select().from(drafts).where(eq(drafts.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function requireDraft(id: string): Promise<Draft> {
  const draft = await getDraft(id);
  if (!draft) throw new Error(`Draft ${id} not found`);
  return draft;
}

export async function updateDraft(
  id: string,
  patch: Partial<Omit<Draft, "id" | "createdAt">>,
): Promise<Draft> {
  const [row] = await db
    .update(drafts)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(drafts.id, id))
    .returning();
  if (!row) throw new Error(`Draft ${id} not found`);
  return row;
}

export async function setDraftStatus(id: string, status: DraftStatus): Promise<Draft> {
  return updateDraft(id, { status });
}

export async function appendFeedback(id: string, entry: FeedbackEntry): Promise<Draft> {
  const [row] = await db
    .update(drafts)
    .set({
      feedbackHistory: sql`${drafts.feedbackHistory} || ${JSON.stringify([entry])}::jsonb`,
      updatedAt: new Date(),
    })
    .where(eq(drafts.id, id))
    .returning();
  if (!row) throw new Error(`Draft ${id} not found`);
  return row;
}

const ACTIVE_STATUSES: DraftStatus[] = [
  "topic_selected",
  "generating",
  "moderating",
  "pending_review",
  "awaiting_confirmation",
  "awaiting_feedback",
  "publishing",
];

export async function listActiveDrafts(): Promise<Draft[]> {
  return db
    .select()
    .from(drafts)
    .where(inArray(drafts.status, ACTIVE_STATUSES))
    .orderBy(desc(drafts.createdAt))
    .limit(10);
}

export async function listRecentDrafts(limit = 5): Promise<Draft[]> {
  return db.select().from(drafts).orderBy(desc(drafts.createdAt)).limit(limit);
}

export async function cancelStaleDrafts(): Promise<number> {
  const rows = await db
    .update(drafts)
    .set({ status: "cancelled", updatedAt: new Date(), errorMessage: "Superseded by a newer run" })
    .where(inArray(drafts.status, ["pending_review", "awaiting_confirmation", "awaiting_feedback"]))
    .returning({ id: drafts.id });
  return rows.length;
}

export function topicFromDraft(draft: Draft): TopicCandidate {
  return {
    title: draft.topicTitle,
    angle: draft.topicAngle,
    whyNow: draft.topicWhyNow,
    sources: draft.topicSources,
  };
}

/* ------------------------------------------------------ conversation state */

export type ConversationState = {
  awaitingFeedbackDraftId: string | null;
  awaitingFeedbackScope: RevisionScope | null;
  awaitingCustomTopicBatchId: string | null;
};

const EMPTY_STATE: ConversationState = {
  awaitingFeedbackDraftId: null,
  awaitingFeedbackScope: null,
  awaitingCustomTopicBatchId: null,
};

export async function getConversationState(chatId: string): Promise<ConversationState> {
  const rows = await db
    .select()
    .from(conversationState)
    .where(eq(conversationState.chatId, chatId))
    .limit(1);
  const row = rows[0];
  if (!row) return EMPTY_STATE;
  return {
    awaitingFeedbackDraftId: row.awaitingFeedbackDraftId,
    awaitingFeedbackScope: row.awaitingFeedbackScope ?? null,
    awaitingCustomTopicBatchId: row.awaitingCustomTopicBatchId,
  };
}

export async function setConversationState(
  chatId: string,
  patch: Partial<ConversationState>,
): Promise<void> {
  const next = { ...EMPTY_STATE, ...patch, updatedAt: new Date() };
  await db
    .insert(conversationState)
    .values({ chatId, ...next })
    .onConflictDoUpdate({ target: conversationState.chatId, set: next });
}

export async function clearConversationState(chatId: string): Promise<void> {
  await setConversationState(chatId, EMPTY_STATE);
}

/* --------------------------------------------------------------- api usage */

export type UsageRecord = {
  label: string;
  model: string;
  promptTokens: number;
  outputTokens: number;
  totalTokens: number;
  thoughtTokens: number;
  ok: boolean;
};

/**
 * Fire-and-forget: accounting must never take down a generation, so failures are
 * swallowed here rather than propagated to the caller.
 */
export async function recordUsage(entry: UsageRecord): Promise<void> {
  await db.insert(apiUsage).values(entry);
}

export type UsageWindow = {
  calls: number;
  failed: number;
  promptTokens: number;
  outputTokens: number;
  totalTokens: number;
};

export type UsageByLabel = UsageWindow & { label: string };

const EMPTY_WINDOW: UsageWindow = {
  calls: 0,
  failed: 0,
  promptTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
};

function windowSince(since: Date) {
  return db
    .select({
      calls: sql<number>`count(*)::int`,
      failed: sql<number>`count(*) filter (where not ${apiUsage.ok})::int`,
      promptTokens: sql<number>`coalesce(sum(${apiUsage.promptTokens}), 0)::int`,
      outputTokens: sql<number>`coalesce(sum(${apiUsage.outputTokens}), 0)::int`,
      totalTokens: sql<number>`coalesce(sum(${apiUsage.totalTokens}), 0)::int`,
    })
    .from(apiUsage)
    .where(gte(apiUsage.createdAt, since));
}

export type UsageSummary = {
  lastHour: UsageWindow;
  today: UsageWindow;
  last7Days: UsageWindow;
  allTime: UsageWindow;
  byLabel: UsageByLabel[];
  since: Date | null;
};

/** Powers /usage. `todayStart` is passed in so the caller owns the timezone. */
export async function summariseUsage(todayStart: Date): Promise<UsageSummary> {
  const now = Date.now();
  const hourAgo = new Date(now - 60 * 60 * 1000);
  const weekAgo = new Date(now - 7 * 24 * 60 * 60 * 1000);
  const epoch = new Date(0);

  const [hour, today, week, all, byLabel, oldest] = await Promise.all([
    windowSince(hourAgo),
    windowSince(todayStart),
    windowSince(weekAgo),
    windowSince(epoch),
    db
      .select({
        label: apiUsage.label,
        calls: sql<number>`count(*)::int`,
        failed: sql<number>`count(*) filter (where not ${apiUsage.ok})::int`,
        promptTokens: sql<number>`coalesce(sum(${apiUsage.promptTokens}), 0)::int`,
        outputTokens: sql<number>`coalesce(sum(${apiUsage.outputTokens}), 0)::int`,
        totalTokens: sql<number>`coalesce(sum(${apiUsage.totalTokens}), 0)::int`,
      })
      .from(apiUsage)
      .where(gte(apiUsage.createdAt, weekAgo))
      .groupBy(apiUsage.label)
      .orderBy(sql`sum(${apiUsage.totalTokens}) desc`),
    db.select({ at: apiUsage.createdAt }).from(apiUsage).orderBy(apiUsage.createdAt).limit(1),
  ]);

  return {
    lastHour: hour[0] ?? EMPTY_WINDOW,
    today: today[0] ?? EMPTY_WINDOW,
    last7Days: week[0] ?? EMPTY_WINDOW,
    allTime: all[0] ?? EMPTY_WINDOW,
    byLabel,
    since: oldest[0]?.at ?? null,
  };
}

/** Clears the awaiting-feedback pointer for a specific draft, wherever it is set. */
export async function clearFeedbackWait(draftId: string): Promise<void> {
  await db
    .update(conversationState)
    .set({ awaitingFeedbackDraftId: null, awaitingFeedbackScope: null, updatedAt: new Date() })
    .where(eq(conversationState.awaitingFeedbackDraftId, draftId));
}
