import { desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "./client.js";
import {
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

/** Clears the awaiting-feedback pointer for a specific draft, wherever it is set. */
export async function clearFeedbackWait(draftId: string): Promise<void> {
  await db
    .update(conversationState)
    .set({ awaitingFeedbackDraftId: null, awaitingFeedbackScope: null, updatedAt: new Date() })
    .where(eq(conversationState.awaitingFeedbackDraftId, draftId));
}
