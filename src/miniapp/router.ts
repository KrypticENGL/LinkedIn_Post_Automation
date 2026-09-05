import { Router } from "express";
import { z } from "zod";
import { pingModel } from "../ai/gemini.js";
import { env } from "../config/env.js";
import type { Draft, TopicCandidate } from "../db/schema.js";
import { getActiveGeminiModel, listRecentDrafts, setActiveGeminiModel } from "../db/repo.js";
import { runHealthChecks } from "../health.js";
import { errorMessage } from "../logger.js";
import { detach } from "../telegram/notify.js";
import { startDraftFromTopic } from "../pipeline/draftPipeline.js";
import { requireApprover } from "./auth.js";

export const miniAppRouter = Router();

miniAppRouter.use(requireApprover);

/* ------------------------------------------------------------------ model */

miniAppRouter.get("/model", async (_req, res) => {
  const active = await getActiveGeminiModel();
  res.json({ active, default: env.GEMINI_MODEL, fallback: env.GEMINI_FALLBACK_MODEL });
});

const setModelBody = z.object({ model: z.string().trim().min(1).max(200) });

miniAppRouter.post("/model", async (req, res) => {
  const parsed = setModelBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "model is required" });
    return;
  }

  const { model } = parsed.data;

  if (model === "default" || model === "reset") {
    await setActiveGeminiModel(null);
    res.json({ active: null, default: env.GEMINI_MODEL, fallback: env.GEMINI_FALLBACK_MODEL });
    return;
  }

  try {
    await pingModel(model);
  } catch (error) {
    res.status(400).json({ error: errorMessage(error) });
    return;
  }

  await setActiveGeminiModel(model);
  res.json({ active: model, default: env.GEMINI_MODEL, fallback: env.GEMINI_FALLBACK_MODEL });
});

/* ------------------------------------------------------------------ quota */

miniAppRouter.get("/quota", async (_req, res) => {
  const report = await runHealthChecks();
  res.json({
    status: report.status,
    models: report.quota.models,
    resetsInMs: report.quota.resetsInMs,
    timeZone: report.quota.timeZone,
  });
});

/* ------------------------------------------------------------------ posts */

/** Trimmed to what a webapp card needs — the full Draft carries image paths, moderation
 *  reports, and feedback history that are Telegram-review concerns, not this list's. */
function toPostSummary(draft: Draft) {
  const text = (draft.postText ?? draft.topicAngle ?? "").trim();
  return {
    id: draft.id,
    title: draft.topicTitle,
    snippet: text.length > 180 ? `${text.slice(0, 180)}…` : text,
    status: draft.status,
    revisionCount: draft.revisionCount,
    createdAt: draft.createdAt.toISOString(),
  };
}

miniAppRouter.get("/posts", async (req, res) => {
  const requested = Number.parseInt(String(req.query.limit ?? ""), 10);
  const limit = Number.isInteger(requested) ? Math.min(Math.max(requested, 1), 50) : 10;
  const drafts = await listRecentDrafts(limit);
  res.json({ posts: drafts.map(toPostSummary) });
});

const newPostBody = z.object({ topic: z.string().trim().min(1).max(4000) });

miniAppRouter.post("/posts", async (req, res) => {
  const parsed = newPostBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "topic is required" });
    return;
  }

  const raw = parsed.data.topic;
  // Mirrors the bot's own custom-topic path (src/telegram/handlers.ts, the
  // awaitingCustomTopicBatchId branch) — same shape, no topic batch to mark used.
  const topic: TopicCandidate = {
    title: raw.slice(0, 120),
    angle: raw,
    whyNow: "Requested from the Sigmσid web app.",
    sources: [],
  };

  // Generation takes a minute or more; answer immediately and let Telegram carry the
  // rest of the review loop, same as every other entry point into the pipeline.
  res.status(202).json({ ok: true });
  detach("Web app draft", startDraftFromTopic(topic, null));
});
