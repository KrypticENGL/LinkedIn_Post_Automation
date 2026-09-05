import type { Context, Filter } from "grammy";
import { pingModel } from "../ai/gemini.js";
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
import {
  clearConversationState,
  getActiveGeminiModel,
  getConversationState,
  getDraft,
  getTopicBatch,
  setActiveGeminiModel,
  setConversationState,
  setDraftStatus,
  updateDraft,
} from "../db/repo.js";
import type { RevisionScope, TopicCandidate } from "../db/schema.js";
import { errorMessage } from "../logger.js";
import { proposeTopics } from "../pipeline/dailyRun.js";
import { applyReviewerFeedback, publishDraft, startDraftFromTopic } from "../pipeline/draftPipeline.js";
import { APPROVER_CHAT_ID, bot, isApprover } from "./bot.js";
import { DRAFT_ACTIONS, modelResetKeyboard, parseCallback } from "./keyboards.js";
import { detach, escapeHtml, showConfirmKeyboard, showRejectKeyboard, showReviewKeyboard } from "./notify.js";

export function registerHandlers(): void {
  /* ----------------------------------------------------------- commands */

  bot.command(["start", "help"], async (ctx) => {
    if (!isApprover(ctx.chat.id)) {
      await ctx.reply(
        `This bot is private. If it is yours, set TELEGRAM_CHAT_ID to ${ctx.chat.id} and restart it.`,
      );
      return;
    }
    await ctx.reply(HELP_MESSAGE, { parse_mode: "HTML" });
  });

  bot.command("topics", async (ctx) => {
    if (!isApprover(ctx.chat.id)) return;
    await ctx.reply(runTopics());
  });

  bot.command("status", async (ctx) => {
    if (!isApprover(ctx.chat.id)) return;
    await ctx.reply(await buildStatusMessage(), { parse_mode: "HTML" });
  });

  bot.command("recent", async (ctx) => {
    if (!isApprover(ctx.chat.id)) return;
    await ctx.reply(await buildRecentMessage(), { parse_mode: "HTML" });
  });

  bot.command("model", async (ctx) => {
    if (!isApprover(ctx.chat.id)) return;

    const requested = ctx.match.trim();
    const activeModel = await getActiveGeminiModel();

    if (!requested) {
      const lines = [
        `Using <code>${escapeHtml(activeModel ?? env.GEMINI_MODEL)}</code>` +
          (activeModel ? " — an override, not the env default." : " — the env default."),
        `Fallback stays <code>${escapeHtml(env.GEMINI_FALLBACK_MODEL)}</code> either way.`,
        "",
        "To switch: <code>/model gemini-2.5-pro</code> (any model name Google's API accepts).",
      ];
      await ctx.reply(lines.join("\n"), {
        parse_mode: "HTML",
        ...(activeModel ? { reply_markup: modelResetKeyboard() } : {}),
      });
      return;
    }

    if (requested === "default" || requested === "reset") {
      if (!activeModel) {
        await ctx.reply(`Already on the default: <code>${escapeHtml(env.GEMINI_MODEL)}</code>`, {
          parse_mode: "HTML",
        });
        return;
      }
      await setActiveGeminiModel(null);
      await ctx.reply(`Back to the default model: <code>${escapeHtml(env.GEMINI_MODEL)}</code>`, {
        parse_mode: "HTML",
      });
      return;
    }

    const placeholder = await ctx.reply(`Checking <code>${escapeHtml(requested)}</code>…`, {
      parse_mode: "HTML",
    });
    try {
      await pingModel(requested);
    } catch (error) {
      await ctx.api.editMessageText(
        ctx.chat.id,
        placeholder.message_id,
        `Could not use <code>${escapeHtml(requested)}</code>: ${escapeHtml(errorMessage(error))}`,
        { parse_mode: "HTML" },
      );
      return;
    }

    await setActiveGeminiModel(requested);
    await ctx.api.editMessageText(
      ctx.chat.id,
      placeholder.message_id,
      `Switched to <code>${escapeHtml(requested)}</code>. Topics, posts, and moderation all use it now — ` +
        `<code>/model default</code> to go back to <code>${escapeHtml(env.GEMINI_MODEL)}</code>.`,
      { parse_mode: "HTML" },
    );
  });

  bot.command("auth", async (ctx) => {
    if (!isApprover(ctx.chat.id)) return;
    const { text } = runAuth();
    await ctx.reply(text, { link_preview_options: { is_disabled: true } });
  });

  bot.command("whoami", async (ctx) => {
    if (!isApprover(ctx.chat.id)) return;
    await ctx.reply(await buildWhoamiMessage(), { parse_mode: "HTML" });
  });

  bot.command("deauth", async (ctx) => {
    if (!isApprover(ctx.chat.id)) return;
    await ctx.reply(await buildDeauthMessage(), { parse_mode: "HTML" });
  });

  bot.command("retry", async (ctx) => {
    if (!isApprover(ctx.chat.id)) return;
    await ctx.reply(await runRetry(), { parse_mode: "HTML" });
  });

  bot.command("usage", async (ctx) => {
    if (!isApprover(ctx.chat.id)) return;
    await ctx.reply(await buildUsageMessage(), { parse_mode: "HTML" });
  });

  bot.command("test", async (ctx) => {
    if (!isApprover(ctx.chat.id)) return;
    // The probes take a couple of seconds; say something first so it doesn't look dead.
    const placeholder = await ctx.reply("Checking…");
    const text = await buildTestMessage();
    await ctx.api.editMessageText(ctx.chat.id, placeholder.message_id, text, { parse_mode: "HTML" });
  });

  bot.command("cancel", async (ctx) => {
    if (!isApprover(ctx.chat.id)) return;
    await ctx.reply(await runCancel());
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
    if (parsed.kind === "m") {
      await setActiveGeminiModel(null);
      await ctx.answerCallbackQuery({ text: "Back to the default model." });
      await ctx.editMessageText(`Back to the default model: <code>${escapeHtml(env.GEMINI_MODEL)}</code>`, {
        parse_mode: "HTML",
      });
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
