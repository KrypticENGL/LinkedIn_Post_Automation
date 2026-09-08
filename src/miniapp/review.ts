import { existsSync } from "node:fs";
import path from "node:path";
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { env } from "../config/env.js";
import {
  clearConversationState,
  getDraft,
  getTopicBatch,
  latestOpenTopicBatch,
  latestReviewableDraft,
  setDraftStatus,
  updateDraft,
} from "../db/repo.js";
import type { Draft, TopicBatch, TopicCandidate } from "../db/schema.js";
import { errorMessage, logger } from "../logger.js";
import { proposeTopics } from "../pipeline/dailyRun.js";
import {
  applyReviewerFeedback,
  publishDraft,
  startDraftFromTopic,
} from "../pipeline/draftPipeline.js";
import { APPROVER_CHAT_ID } from "../telegram/bot.js";
import {
  clearKeyboard,
  clearTopicButtons,
  detach,
  escapeHtml,
  notify,
  showConfirmKeyboard,
  showReviewKeyboard,
} from "../telegram/notify.js";

/**
 * The web-app side of the Telegram review loop: the same pick-a-topic,
 * approve / reject-with-changes / confirm / cancel actions the bot offers as
 * inline buttons, exposed as JSON so the Sigmσid web app can drive them too.
 *
 * Every handler calls the exact same pipeline function as the matching
 * `bot.on("callback_query")` branch in src/telegram/handlers.ts, so the two
 * interfaces move the one draft through the one state machine. Telegram keeps
 * working throughout — where a web action changes state, the bot's live buttons
 * are swapped to match (showConfirmKeyboard / clearKeyboard / clearTopicButtons)
 * and a short note is teed to the chat.
 */
export const reviewRouter = Router();

/* --------------------------------------------------------------- serialisers */

function toReviewTopicBatch(batch: TopicBatch) {
  return {
    id: batch.id,
    topics: batch.topics,
    createdAt: batch.createdAt.toISOString(),
  };
}

function toReviewDraft(draft: Draft) {
  return {
    id: draft.id,
    topicTitle: draft.topicTitle,
    postText: draft.postText ?? "",
    status: draft.status,
    revisionCount: draft.revisionCount,
    maxRevisions: env.MAX_REVISIONS,
    moderation: draft.moderation,
    hasImage: Boolean(draft.imagePath),
    imageUrl: draft.imagePath ? `/api/drafts/${draft.id}/image` : null,
    imageAltText: draft.imageAltText,
    feedbackHistory: draft.feedbackHistory,
    errorMessage: draft.errorMessage,
    updatedAt: draft.updatedAt.toISOString(),
  };
}

/* -------------------------------------------------------------------- review */

reviewRouter.get("/review", async (_req, res) => {
  const [batch, draft] = await Promise.all([latestOpenTopicBatch(), latestReviewableDraft()]);
  res.json({
    topicBatch: batch ? toReviewTopicBatch(batch) : null,
    draft: draft ? toReviewDraft(draft) : null,
  });
});

/* -------------------------------------------------------------------- topics */

reviewRouter.post("/topics/scan", (_req, res) => {
  res.status(202).json({ ok: true });
  detach("Topic scan", proposeTopics());
});

reviewRouter.post("/topics/:batchId/refresh", async (req, res) => {
  const batch = await getTopicBatch(req.params.batchId);
  if (batch?.status === "open") await clearTopicButtons(batch);
  res.status(202).json({ ok: true });
  detach("Topic scan", proposeTopics());
});

const pickBody = z.object({ index: z.number().int().nonnegative() });

reviewRouter.post("/topics/:batchId/pick", async (req, res) => {
  const parsed = pickBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "index is required" });
    return;
  }

  const batch = await getTopicBatch(req.params.batchId);
  if (!batch) {
    res.status(404).json({ error: "That topic list is gone. Scan for new options." });
    return;
  }
  if (batch.status === "used") {
    res.status(409).json({ error: "A topic was already picked from this list." });
    return;
  }

  const topic = batch.topics[parsed.data.index];
  if (!topic) {
    res.status(400).json({ error: "That option is no longer available." });
    return;
  }

  await clearTopicButtons(batch);
  await notify(`✍️ Writing a post on <b>${escapeHtml(topic.title)}</b> (picked from the web app).`);
  res.status(202).json({ ok: true });
  detach("Draft generation", startDraftFromTopic(topic, batch.id));
});

const customBody = z.object({ angle: z.string().trim().min(1).max(4000) });

reviewRouter.post("/topics/:batchId/custom", async (req, res) => {
  const parsed = customBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "angle is required" });
    return;
  }

  const batch = await getTopicBatch(req.params.batchId);
  const text = parsed.data.angle;
  // Mirrors handlers.ts's awaitingCustomTopicBatchId branch.
  const topic: TopicCandidate = {
    title: text.slice(0, 120),
    angle: text,
    whyNow: "Requested from the Sigmσid web app.",
    sources: [],
  };

  if (batch?.status === "open") await clearTopicButtons(batch);
  await notify(`✍️ Writing a post on that (topic sent from the web app).`);
  res.status(202).json({ ok: true });
  detach("Custom topic draft", startDraftFromTopic(topic, batch?.status === "open" ? batch.id : null));
});

/* -------------------------------------------------------------------- images */

reviewRouter.get("/drafts/:id/image", async (req, res) => {
  const draft = await getDraft(req.params.id);
  if (!draft?.imagePath) {
    res.status(404).json({ error: "No image for this draft" });
    return;
  }

  const absolute = path.resolve(draft.imagePath);
  if (!existsSync(absolute)) {
    logger.warn({ draftId: draft.id, imagePath: draft.imagePath }, "Draft image file missing on disk");
    res.status(404).json({ error: "Image file is missing" });
    return;
  }

  res.setHeader("Cache-Control", "private, max-age=60");
  res.sendFile(absolute, (err) => {
    if (err && !res.headersSent) res.status(500).end();
  });
});

/* -------------------------------------------------------------------- drafts */

/** Loads the draft named in the URL, or answers 404 and returns null. */
async function loadDraft(req: Request, res: Response): Promise<Draft | null> {
  const draft = await getDraft(String(req.params.id));
  if (!draft) {
    res.status(404).json({ error: "That draft no longer exists." });
    return null;
  }
  return draft;
}

reviewRouter.post("/drafts/:id/approve", async (req, res) => {
  const draft = await loadDraft(req, res);
  if (!draft) return;

  if (draft.status !== "pending_review") {
    res.status(409).json({ error: `Draft is ${draft.status}, not awaiting review.` });
    return;
  }

  const updated = await setDraftStatus(draft.id, "awaiting_confirmation");
  await showConfirmKeyboard(updated);
  await notify(
    "✅ Approved from the web app. One more confirmation — <b>publishing to LinkedIn cannot be undone</b>.",
  );
  res.json({ draft: toReviewDraft(updated) });
});

reviewRouter.post("/drafts/:id/back", async (req, res) => {
  const draft = await loadDraft(req, res);
  if (!draft) return;

  if (draft.status !== "awaiting_confirmation") {
    res.status(409).json({ error: `Draft is ${draft.status}, not awaiting confirmation.` });
    return;
  }

  const updated = await setDraftStatus(draft.id, "pending_review");
  await showReviewKeyboard(updated);
  await notify("↩️ Held back from the web app. Nothing was posted.");
  res.json({ draft: toReviewDraft(updated) });
});

reviewRouter.post("/drafts/:id/confirm", async (req, res) => {
  const draft = await loadDraft(req, res);
  if (!draft) return;

  if (draft.status !== "awaiting_confirmation") {
    res.status(409).json({ error: `Draft is ${draft.status}; approve it first.` });
    return;
  }

  res.status(202).json({ ok: true });
  detach("Publish", publishDraft(draft.id));
});

const reviseBody = z.object({
  scope: z.enum(["text", "image", "both"]),
  feedback: z.string().trim().min(1).max(4000),
});

reviewRouter.post("/drafts/:id/revise", async (req, res) => {
  const parsed = reviseBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "scope and feedback are required" });
    return;
  }

  const draft = await loadDraft(req, res);
  if (!draft) return;

  if (!["pending_review", "awaiting_confirmation", "moderation_blocked"].includes(draft.status)) {
    res.status(409).json({ error: `Draft is ${draft.status}; nothing to revise.` });
    return;
  }
  if (draft.revisionCount >= env.MAX_REVISIONS) {
    res.status(409).json({
      error: `This draft has been revised ${draft.revisionCount} times, the configured limit. Cancel it and start again.`,
    });
    return;
  }

  const { scope, feedback } = parsed.data;
  // Telegram may have been left waiting on a "reply with your changes" prompt for
  // this same draft; the web app just supplied those changes, so drop that wait.
  await clearConversationState(APPROVER_CHAT_ID);
  const target = scope === "text" ? "the text" : scope === "image" ? "the image" : "the post and image";
  await notify(
    `📝 Change requested from the web app (${escapeHtml(target)}):\n<blockquote>${escapeHtml(feedback)}</blockquote>`,
  );

  res.status(202).json({ ok: true });
  detach("Revision", applyReviewerFeedback(draft.id, scope, feedback));
});

reviewRouter.post("/drafts/:id/cancel", async (req, res) => {
  const draft = await loadDraft(req, res);
  if (!draft) return;

  if (["posted", "publishing", "cancelled"].includes(draft.status)) {
    res.status(409).json({ error: `Draft is ${draft.status}; too late to cancel.` });
    return;
  }

  const updated = await updateDraft(draft.id, { status: "cancelled" });
  await clearKeyboard(updated);
  await clearConversationState(APPROVER_CHAT_ID);
  await notify("🗑 Post cancelled from the web app. Nothing was sent to LinkedIn.");
  res.json({ draft: toReviewDraft(updated) });
});
