import { InputFile, type InlineKeyboard } from "grammy";
import type { Draft, ModerationReport, TopicBatch } from "../db/schema.js";
import { describeModeration } from "../moderation/index.js";
import { setTopicBatchMessageId, updateDraft } from "../db/repo.js";
import { errorMessage, logger } from "../logger.js";
import { APPROVER_CHAT_ID, bot } from "./bot.js";
import {
  blockedKeyboard,
  confirmKeyboard,
  rejectKeyboard,
  reviewKeyboard,
  topicKeyboard,
} from "./keyboards.js";

const CHAT = APPROVER_CHAT_ID;

export function escapeHtml(input: string): string {
  return input.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export async function notify(text: string): Promise<void> {
  await bot.api.sendMessage(CHAT, text, { parse_mode: "HTML" });
}

/* ------------------------------------------------------------------ topics */

export async function sendTopicOptions(batch: TopicBatch): Promise<void> {
  const lines = [
    "<b>Today's hot topics</b>",
    "Pick one and I'll write the post.",
    "",
    ...batch.topics.map((topic, index) => {
      const sources = topic.sources.length
        ? `\n   <i>sources: ${topic.sources.map((s) => escapeHtml(s.publisher ?? "link")).join(", ")}</i>`
        : "";
      return `<b>${index + 1}. ${escapeHtml(topic.title)}</b>\n   ${escapeHtml(topic.angle)}\n   <i>${escapeHtml(topic.whyNow)}</i>${sources}`;
    }),
  ];

  const message = await bot.api.sendMessage(CHAT, lines.join("\n"), {
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
    reply_markup: topicKeyboard(batch.id, batch.topics),
  });

  await setTopicBatchMessageId(batch.id, message.message_id);
}

/* ------------------------------------------------------------------ drafts */

function reviewBody(draft: Draft, moderation: ModerationReport | null): string {
  const charCount = draft.postText?.length ?? 0;
  return [
    `<b>${escapeHtml(draft.topicTitle)}</b>`,
    moderation ? escapeHtml(describeModeration(moderation)) : "",
    "",
    "<blockquote expandable>" + escapeHtml(draft.postText ?? "(no text)") + "</blockquote>",
    "",
    `<i>Revision ${draft.revisionCount} · ${charCount} characters</i>`,
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Posts the image and the review message with Approve/Reject, replacing any
 * previous review message for this draft so old buttons cannot be re-clicked.
 */
export async function presentDraftForReview(draft: Draft): Promise<Draft> {
  await retireMessages(draft);

  let photoMessageId: number | null = null;
  if (draft.imagePath) {
    try {
      const photo = await bot.api.sendPhoto(CHAT, new InputFile(draft.imagePath), {
        caption: draft.imageAltText ? escapeHtml(draft.imageAltText).slice(0, 900) : undefined,
        parse_mode: "HTML",
      });
      photoMessageId = photo.message_id;
    } catch (error) {
      logger.warn({ draftId: draft.id, err: errorMessage(error) }, "Could not send draft image");
    }
  }

  const message = await bot.api.sendMessage(CHAT, reviewBody(draft, draft.moderation), {
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
    reply_markup: reviewKeyboard(draft.id),
  });

  return updateDraft(draft.id, {
    telegramReviewMessageId: message.message_id,
    telegramPhotoMessageId: photoMessageId,
  });
}

/** Sends a blocked draft with a "tell it what to fix" / discard choice. */
export async function presentBlockedDraft(draft: Draft): Promise<Draft> {
  await retireMessages(draft);

  const body = [
    `<b>${escapeHtml(draft.topicTitle)}</b>`,
    "🚫 <b>This draft did not pass the safety check.</b>",
    draft.moderation ? escapeHtml(describeModeration(draft.moderation)) : "",
    "",
    draft.postText ? "<blockquote expandable>" + escapeHtml(draft.postText) + "</blockquote>" : "",
    "",
    "<i>Nothing has been sent to LinkedIn.</i>",
  ]
    .filter(Boolean)
    .join("\n");

  const message = await bot.api.sendMessage(CHAT, body, {
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
    reply_markup: blockedKeyboard(draft.id),
  });

  return updateDraft(draft.id, { telegramReviewMessageId: message.message_id });
}

async function swapKeyboard(draft: Draft, keyboard: InlineKeyboard | undefined): Promise<void> {
  if (!draft.telegramReviewMessageId) return;
  try {
    await bot.api.editMessageReplyMarkup(CHAT, draft.telegramReviewMessageId, {
      reply_markup: keyboard,
    });
  } catch (error) {
    // Telegram rejects a no-op edit; that is not worth surfacing.
    logger.debug({ draftId: draft.id, err: errorMessage(error) }, "Keyboard edit skipped");
  }
}

export const showConfirmKeyboard = (draft: Draft) => swapKeyboard(draft, confirmKeyboard(draft.id));
export const showRejectKeyboard = (draft: Draft) => swapKeyboard(draft, rejectKeyboard(draft.id));
export const showReviewKeyboard = (draft: Draft) => swapKeyboard(draft, reviewKeyboard(draft.id));
export const clearKeyboard = (draft: Draft) => swapKeyboard(draft, undefined);

/** Removes buttons from a draft's previous messages before a new round is posted. */
async function retireMessages(draft: Draft): Promise<void> {
  if (!draft.telegramReviewMessageId) return;
  try {
    await bot.api.editMessageReplyMarkup(CHAT, draft.telegramReviewMessageId, {
      reply_markup: undefined,
    });
  } catch {
    // Message may be too old to edit; the new message supersedes it anyway.
  }
}

export async function announcePublished(draft: Draft, postUrl: string): Promise<void> {
  await bot.api.sendMessage(
    CHAT,
    [
      "🚀 <b>Posted to LinkedIn.</b>",
      escapeHtml(draft.topicTitle),
      "",
      `<a href="${escapeHtml(postUrl)}">View the post</a>`,
    ].join("\n"),
    { parse_mode: "HTML" },
  );
}

export async function announceFailure(draft: Draft, reason: string): Promise<void> {
  await bot.api.sendMessage(
    CHAT,
    [
      "❗️ <b>Publishing failed.</b>",
      escapeHtml(draft.topicTitle),
      "",
      `<code>${escapeHtml(reason)}</code>`,
      "",
      "The draft is kept. Fix the cause and use /retry to try again.",
    ].join("\n"),
    { parse_mode: "HTML" },
  );
}

export async function sendWorkingNotice(text: string): Promise<number | null> {
  try {
    const message = await bot.api.sendMessage(CHAT, text);
    return message.message_id;
  } catch {
    return null;
  }
}

export async function deleteMessage(messageId: number | null): Promise<void> {
  if (messageId === null) return;
  try {
    await bot.api.deleteMessage(CHAT, messageId);
  } catch {
    // Non-fatal.
  }
}
