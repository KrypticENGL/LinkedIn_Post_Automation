import type { Context, Filter } from "grammy";
import { env } from "../config/env.js";
import {
  clearConversationState,
  getConversationState,
  getDraft,
  getTopicBatch,
  listActiveDrafts,
  listRecentDrafts,
  setConversationState,
  setDraftStatus,
  updateDraft,
} from "../db/repo.js";
import type { RevisionScope, TopicCandidate } from "../db/schema.js";
import { errorMessage, logger } from "../logger.js";
import { buildAuthorizationUrl, getConnectedAccount } from "../linkedin/oauth.js";
import { proposeTopics } from "../pipeline/dailyRun.js";
import {
  applyReviewerFeedback,
  publishDraft,
  retryPublish,
  startDraftFromTopic,
} from "../pipeline/draftPipeline.js";
import { APPROVER_CHAT_ID, bot, isApprover } from "./bot.js";
import { DRAFT_ACTIONS, parseCallback } from "./keyboards.js";
import {
  escapeHtml,
  notify,
  showConfirmKeyboard,
  showRejectKeyboard,
  showReviewKeyboard,
} from "./notify.js";

/**
 * Telegram expects a callback answered within seconds, but a generation round
 * takes a minute or more. Heavy work is therefore detached from the handler and
 * reports its own failures.
 */
function detach(label: string, work: Promise<unknown>): void {
  void work.catch(async (error) => {
    logger.error({ label, err: errorMessage(error) }, "Background task failed");
    try {
      await notify(`❗️ ${escapeHtml(label)} failed.\n<code>${escapeHtml(errorMessage(error))}</code>`);
    } catch {
      // Telegram itself is down; the log line above is the record.
    }
  });
}

const HELP = [
  "<b>LinkedIn post automation</b>",
  "",
  `Every day at <code>${env.DAILY_CRON}</code> (${env.TIMEZONE}) I fetch the hottest business and marketing stories, turn them into ${env.TOPIC_COUNT} topic options, and ask you to pick one.`,
  "",
  "Then: I write the post, generate an image, run both through a safety check, and send them here for approval. Nothing reaches LinkedIn without your explicit confirmation.",
  "",
  "<b>Commands</b>",
  "/topics — fetch today's hot topics now",
  "/status — what's in flight",
  "/recent — the last few drafts",
  "/auth — connect or reconnect LinkedIn",
  "/whoami — which LinkedIn account is connected",
  "/retry — retry publishing the last failed draft",
  "/cancel — stop waiting for a reply from me",
].join("\n");

export function registerHandlers(): void {
  /* ----------------------------------------------------------- commands */

  bot.command(["start", "help"], async (ctx) => {
    if (!isApprover(ctx.chat.id)) {
      await ctx.reply(
        `This bot is private. If it is yours, set TELEGRAM_CHAT_ID to ${ctx.chat.id} and restart it.`,
      );
      return;
    }
    await ctx.reply(HELP, { parse_mode: "HTML" });
  });

  bot.command("topics", async (ctx) => {
    if (!isApprover(ctx.chat.id)) return;
    await ctx.reply("On it.");
    detach("Topic scan", proposeTopics());
  });

  bot.command("status", async (ctx) => {
    if (!isApprover(ctx.chat.id)) return;
    const active = await listActiveDrafts();
    if (active.length === 0) {
      await ctx.reply("Nothing in flight. Use /topics to start something.");
      return;
    }
    const lines = active.map(
      (draft) =>
        `• <b>${escapeHtml(draft.topicTitle)}</b>\n  ${draft.status} · revision ${draft.revisionCount}`,
    );
    await ctx.reply(["<b>In flight</b>", ...lines].join("\n"), { parse_mode: "HTML" });
  });

  bot.command("recent", async (ctx) => {
    if (!isApprover(ctx.chat.id)) return;
    const recent = await listRecentDrafts(5);
    if (recent.length === 0) {
      await ctx.reply("No drafts yet.");
      return;
    }
    const lines = recent.map((draft) => {
      const when = draft.createdAt.toISOString().slice(0, 16).replace("T", " ");
      return `• ${when} — <b>${escapeHtml(draft.topicTitle)}</b> (${draft.status})`;
    });
    await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
  });

  bot.command("auth", async (ctx) => {
    if (!isApprover(ctx.chat.id)) return;
    const { url } = buildAuthorizationUrl();
    await ctx.reply(
      [
        "Open this link and approve access for the LinkedIn profile that should be posting:",
        "",
        url,
        "",
        "The link is valid for 15 minutes.",
      ].join("\n"),
      { link_preview_options: { is_disabled: true } },
    );
  });

  bot.command("whoami", async (ctx) => {
    if (!isApprover(ctx.chat.id)) return;
    const account = await getConnectedAccount();
    if (!account) {
      await ctx.reply("No LinkedIn account connected. Run /auth.");
      return;
    }
    await ctx.reply(
      `Connected as <code>${escapeHtml(account.memberUrn)}</code>\nToken valid until ${account.expiresAt.toISOString()}`,
      { parse_mode: "HTML" },
    );
  });

  bot.command("retry", async (ctx) => {
    if (!isApprover(ctx.chat.id)) return;
    const recent = await listRecentDrafts(10);
    const failed = recent.find((draft) => draft.status === "failed");
    if (!failed) {
      await ctx.reply("No failed draft to retry.");
      return;
    }
    await ctx.reply(`Retrying: ${failed.topicTitle}`);
    detach("Retry publish", retryPublish(failed.id));
  });

  bot.command("cancel", async (ctx) => {
    if (!isApprover(ctx.chat.id)) return;
    await clearConversationState(APPROVER_CHAT_ID);
    await ctx.reply("Fine — I've stopped waiting for a reply.");
  });

  /* ---------------------------------------------------------- callbacks */

  bot.on("callback_query:data", async (ctx) => {
    if (!isApprover(ctx.chat?.id)) {
      await ctx.answerCallbackQuery({ text: "Not your bot." });
      return;
    }

    const parsed = parseCallback(ctx.callbackQuery.data);
    if (!parsed) {
      await ctx.answerCallbackQuery({ text: "Unrecognised button." });
      return;
    }

    if (parsed.kind === "t") {
      await handleTopicCallback(ctx, parsed.id, parsed.action);
      return;
    }
    await handleDraftCallback(ctx, parsed.id, parsed.action);
  });

  /* -------------------------------------------------------- text replies */

  bot.on("message:text", async (ctx) => {
    if (!isApprover(ctx.chat.id)) return;
    const text = ctx.message.text.trim();
    if (text.startsWith("/")) return;

    const state = await getConversationState(APPROVER_CHAT_ID);

    if (state.awaitingFeedbackDraftId) {
      const draftId = state.awaitingFeedbackDraftId;
      const scope: RevisionScope = state.awaitingFeedbackScope ?? "text";
      await clearConversationState(APPROVER_CHAT_ID);
      await ctx.reply("Got it — reworking now.");
      detach("Revision", applyReviewerFeedback(draftId, scope, text));
      return;
    }

    if (state.awaitingCustomTopicBatchId) {
      const batchId = state.awaitingCustomTopicBatchId;
      await clearConversationState(APPROVER_CHAT_ID);
      const topic: TopicCandidate = {
        title: text.slice(0, 120),
        angle: text,
        whyNow: "Requested directly by the reviewer.",
        sources: [],
      };
      await ctx.reply("Writing a post on that.");
      detach("Custom topic draft", startDraftFromTopic(topic, batchId));
      return;
    }

    await ctx.reply(
      "I'm not waiting on anything right now. Use /topics to start a post, or /help to see what I can do.",
    );
  });
}

/* --------------------------------------------------------------- handlers */

type Ctx = Filter<Context, "callback_query:data">;

async function handleTopicCallback(ctx: Ctx, batchId: string, action: string): Promise<void> {
  const batch = await getTopicBatch(batchId);
  if (!batch) {
    await ctx.answerCallbackQuery({ text: "That topic list is gone. Use /topics." });
    return;
  }

  if (action === "x") {
    await ctx.answerCallbackQuery({ text: "Fetching new options…" });
    await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => undefined);
    detach("Topic scan", proposeTopics());
    return;
  }

  if (action === "c") {
    await setConversationState(APPROVER_CHAT_ID, { awaitingCustomTopicBatchId: batchId });
    await ctx.answerCallbackQuery();
    await ctx.reply("Send me the topic or angle you want, in your own words.");
    return;
  }

  if (batch.status === "used") {
    await ctx.answerCallbackQuery({ text: "A topic was already picked from this list." });
    return;
  }

  const index = Number.parseInt(action, 10);
  const topic = Number.isInteger(index) ? batch.topics[index] : undefined;
  if (!topic) {
    await ctx.answerCallbackQuery({ text: "That option is no longer available." });
    return;
  }

  await ctx.answerCallbackQuery({ text: `Writing: ${topic.title}`.slice(0, 200) });
  await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => undefined);
  detach("Draft generation", startDraftFromTopic(topic, batchId));
}

async function handleDraftCallback(ctx: Ctx, draftId: string, action: string): Promise<void> {
  const draft = await getDraft(draftId);
  if (!draft) {
    await ctx.answerCallbackQuery({ text: "That draft no longer exists." });
    return;
  }

  switch (action) {
    case DRAFT_ACTIONS.approve: {
      if (draft.status !== "pending_review") {
        await ctx.answerCallbackQuery({ text: `Draft is ${draft.status}, not awaiting review.` });
        return;
      }
      const updated = await setDraftStatus(draftId, "awaiting_confirmation");
      await showConfirmKeyboard(updated);
      await ctx.answerCallbackQuery({ text: "One more confirmation and it goes live." });
      await ctx.reply(
        "⚠️ <b>Final confirmation.</b> Publishing this to LinkedIn cannot be undone from here.",
        { parse_mode: "HTML" },
      );
      return;
    }

    case DRAFT_ACTIONS.backToReview: {
      const updated = await setDraftStatus(draftId, "pending_review");
      await showReviewKeyboard(updated);
      await ctx.answerCallbackQuery({ text: "Held back. Nothing was posted." });
      return;
    }

    case DRAFT_ACTIONS.confirmPost: {
      if (draft.status !== "awaiting_confirmation") {
        await ctx.answerCallbackQuery({ text: `Draft is ${draft.status}; approve it first.` });
        return;
      }
      await ctx.answerCallbackQuery({ text: "Publishing…" });
      detach("Publish", publishDraft(draftId));
      return;
    }

    case DRAFT_ACTIONS.reject: {
      await showRejectKeyboard(draft);
      await ctx.answerCallbackQuery({ text: "What should change?" });
      return;
    }

    case DRAFT_ACTIONS.changeText:
    case DRAFT_ACTIONS.changeImage:
    case DRAFT_ACTIONS.changeBoth: {
      const scope: RevisionScope =
        action === DRAFT_ACTIONS.changeText
          ? "text"
          : action === DRAFT_ACTIONS.changeImage
            ? "image"
            : "both";

      if (draft.revisionCount >= env.MAX_REVISIONS) {
        await ctx.answerCallbackQuery({ text: "Revision limit reached for this draft." });
        await ctx.reply(
          `This draft has already been revised ${draft.revisionCount} times. Cancel it and start again with /topics.`,
        );
        return;
      }

      await setDraftStatus(draftId, "awaiting_feedback");
      await setConversationState(APPROVER_CHAT_ID, {
        awaitingFeedbackDraftId: draftId,
        awaitingFeedbackScope: scope,
      });
      await ctx.answerCallbackQuery();

      const target =
        scope === "text" ? "the post text" : scope === "image" ? "the image" : "the post and the image";
      await ctx.reply(
        `Reply with what you want changed about ${target}. Be as specific as you like — "cut the third paragraph", "make the hook sharper", "warmer colours". Send /cancel to drop it.`,
      );
      return;
    }

    case DRAFT_ACTIONS.cancel: {
      await updateDraft(draftId, { status: "cancelled" });
      await clearConversationState(APPROVER_CHAT_ID);
      await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => undefined);
      await ctx.answerCallbackQuery({ text: "Cancelled." });
      await ctx.reply("🗑 Post cancelled. Nothing was sent to LinkedIn. Use /topics to start another.");
      return;
    }

    default: {
      await ctx.answerCallbackQuery({ text: "Unknown action." });
    }
  }
}
