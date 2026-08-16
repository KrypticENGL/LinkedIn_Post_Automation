import { InlineKeyboard } from "grammy";
import type { TopicCandidate } from "../db/schema.js";

/**
 * Callback payloads are capped at 64 bytes by Telegram, so actions are two-letter
 * codes: "d|<uuid>|ap" is 41 bytes.
 */
export const DRAFT_ACTIONS = {
  approve: "ap",
  reject: "rj",
  confirmPost: "cf",
  backToReview: "nb",
  cancel: "cn",
  changeText: "ct",
  changeImage: "ci",
  changeBoth: "cb",
} as const;

export type DraftAction = (typeof DRAFT_ACTIONS)[keyof typeof DRAFT_ACTIONS];

export const draftCb = (draftId: string, action: DraftAction) => `d|${draftId}|${action}`;
export const topicCb = (batchId: string, key: string) => `t|${batchId}|${key}`;

export function parseCallback(data: string): { kind: "d" | "t"; id: string; action: string } | null {
  const [kind, id, action] = data.split("|");
  if ((kind !== "d" && kind !== "t") || !id || !action) return null;
  return { kind, id, action };
}

export function topicKeyboard(batchId: string, topics: TopicCandidate[]): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  topics.forEach((topic, index) => {
    const label = `${index + 1}. ${topic.title}`.slice(0, 60);
    keyboard.text(label, topicCb(batchId, String(index))).row();
  });
  keyboard
    .text("✍️ My own topic", topicCb(batchId, "c"))
    .text("🔄 New options", topicCb(batchId, "x"));
  return keyboard;
}

export const reviewKeyboard = (draftId: string) =>
  new InlineKeyboard()
    .text("✅ Approve", draftCb(draftId, DRAFT_ACTIONS.approve))
    .text("❌ Reject", draftCb(draftId, DRAFT_ACTIONS.reject));

export const confirmKeyboard = (draftId: string) =>
  new InlineKeyboard()
    .text("🚀 Yes, post it now", draftCb(draftId, DRAFT_ACTIONS.confirmPost))
    .row()
    .text("↩️ Wait, go back", draftCb(draftId, DRAFT_ACTIONS.backToReview));

export const rejectKeyboard = (draftId: string) =>
  new InlineKeyboard()
    .text("📝 Change the text", draftCb(draftId, DRAFT_ACTIONS.changeText))
    .row()
    .text("🖼 Change the image", draftCb(draftId, DRAFT_ACTIONS.changeImage))
    .row()
    .text("🔁 Change both", draftCb(draftId, DRAFT_ACTIONS.changeBoth))
    .row()
    .text("🗑 Cancel this post", draftCb(draftId, DRAFT_ACTIONS.cancel));

/** Shown when a draft is blocked by the safety gate. */
export const blockedKeyboard = (draftId: string) =>
  new InlineKeyboard()
    .text("📝 Tell it what to fix", draftCb(draftId, DRAFT_ACTIONS.changeBoth))
    .row()
    .text("🗑 Discard", draftCb(draftId, DRAFT_ACTIONS.cancel));
