import { Router } from "express";
import { z } from "zod";
import { pingModel } from "../ai/gemini.js";
import { modalCoolingDown, modalTextEnabled } from "../ai/modalProxy.js";
import { env } from "../config/env.js";
import {
  buildDeauthMessage,
  buildRecentMessage,
  buildStatusMessage,
  buildTestMessage,
  buildUsageMessage,
  buildWhoamiMessage,
  HELP_MESSAGE,
  runAuth,
  runCancel,
  runRetry,
  runTopics,
} from "../commands/index.js";
import type { Draft, TopicCandidate } from "../db/schema.js";
import {
  getActiveGeminiModel,
  latestDraftWithText,
  listRecentDrafts,
  setActiveGeminiModel,
} from "../db/repo.js";
import { runHealthChecks } from "../health.js";
import { errorMessage } from "../logger.js";
import { activitySince } from "./activity.js";
import { detach } from "../telegram/notify.js";
import { startDraftFromText, startDraftFromTopic } from "../pipeline/draftPipeline.js";
import { requireApprover } from "./auth.js";

export const miniAppRouter = Router();

miniAppRouter.use(requireApprover);

/* ------------------------------------------------------------------ model */

/**
 * The model picker also needs to know which *service* is answering: when Modal is
 * configured every call goes to it first and falls back to Google AI Studio on
 * failure (see src/ai/modalProxy.ts). `activeService` is the best guess right now —
 * "Google AI Studio" while Modal is in its post-failure cooldown.
 */
function modelInfo(active: string | null) {
  const modal = modalTextEnabled();
  return {
    active,
    default: env.GEMINI_MODEL,
    fallback: env.GEMINI_FALLBACK_MODEL,
    modalEnabled: modal,
    activeService: modal && !modalCoolingDown() ? "Modal" : "Google AI Studio",
  };
}

miniAppRouter.get("/model", async (_req, res) => {
  res.json(modelInfo(await getActiveGeminiModel()));
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
    res.json(modelInfo(null));
    return;
  }

  try {
    await pingModel(model);
  } catch (error) {
    res.status(400).json({ error: errorMessage(error) });
    return;
  }

  await setActiveGeminiModel(model);
  res.json(modelInfo(model));
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

/** Full text of the most recent draft — the web app's preview editor loads this so
 *  the reviewer can tweak what the pipeline generated before sending it on. */
miniAppRouter.get("/posts/latest", async (_req, res) => {
  const draft = await latestDraftWithText();
  if (!draft) {
    res.status(404).json({ error: "No drafts with text yet" });
    return;
  }
  res.json({
    id: draft.id,
    title: draft.topicTitle,
    postText: draft.postText ?? "",
    status: draft.status,
    createdAt: draft.createdAt.toISOString(),
  });
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

// LinkedIn's hard limit is 3000; the pipeline trims to MAX_POST_CHARS itself.
const fromTextBody = z.object({ postText: z.string().trim().min(1).max(3000) });

/**
 * The preview editor's "Send through automation" button. Unlike POST /posts, this
 * takes the finished post text as-is — no topic, no AI writing pass — runs the
 * safety gate, and drops it straight into the Telegram approve/confirm/publish loop.
 */
miniAppRouter.post("/posts/from-text", async (req, res) => {
  const parsed = fromTextBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "postText is required" });
    return;
  }

  // Moderation is a model round-trip; answer now, review in Telegram.
  res.status(202).json({ ok: true });
  detach("Web app preview post", startDraftFromText(parsed.data.postText));
});

/* ------------------------------------------------------------------ activity */

/**
 * Everything the bot has just told the approver — topic lists, "working…" notices,
 * draft-ready messages, publish results, background failures — teed from the same
 * `notify()` path that talks to Telegram (see src/miniapp/activity.ts). The web
 * app polls this so a `/topics` run (whose real output is async) shows up in the
 * composer, not only in the Telegram chat. Pass back the `cursor` from the last
 * response as `?since=` to get only what is new.
 */
miniAppRouter.get("/activity", (req, res) => {
  const since = Number.parseInt(String(req.query.since ?? "0"), 10);
  res.json(activitySince(Number.isFinite(since) ? since : 0));
});

/* -------------------------------------------------------------- commands */

/**
 * Every bot command that isn't tied to a specific draft's inline keyboard (those —
 * approve/reject/confirm/revise a particular message — only make sense as a Telegram
 * callback and stay there). Each one calls the exact same function as the matching
 * bot.command() in src/telegram/handlers.ts, so it does the same real thing and says
 * the same thing — just answered as JSON instead of a Telegram message.
 */
const COMMANDS: Record<string, () => Promise<{ html: string; url?: string }>> = {
  help: async () => ({ html: HELP_MESSAGE }),
  topics: async () => ({ html: runTopics() }),
  status: async () => ({ html: await buildStatusMessage() }),
  recent: async () => ({ html: await buildRecentMessage() }),
  usage: async () => ({ html: await buildUsageMessage() }),
  test: async () => ({ html: await buildTestMessage() }),
  whoami: async () => ({ html: await buildWhoamiMessage() }),
  deauth: async () => ({ html: await buildDeauthMessage() }),
  retry: async () => ({ html: await runRetry() }),
  cancel: async () => ({ html: await runCancel() }),
  auth: async () => {
    const { text, url } = runAuth();
    return { html: text, url };
  },
};

miniAppRouter.post("/commands/:name", async (req, res) => {
  const run = COMMANDS[req.params.name];
  if (!run) {
    res.status(404).json({ error: `Unknown command: /${req.params.name}` });
    return;
  }
  res.json(await run());
});
