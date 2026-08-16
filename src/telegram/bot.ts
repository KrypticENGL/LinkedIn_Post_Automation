import { Bot } from "grammy";
import { env } from "../config/env.js";
import { errorMessage, logger } from "../logger.js";

export const bot = new Bot(env.TELEGRAM_BOT_TOKEN);

export const APPROVER_CHAT_ID = env.TELEGRAM_CHAT_ID;

/** Every handler is locked to the single approver chat. */
export function isApprover(chatId: number | string | undefined): boolean {
  return String(chatId) === APPROVER_CHAT_ID;
}

bot.catch((error) => {
  logger.error({ err: errorMessage(error.error), update: error.ctx.update.update_id }, "Telegram handler failed");
});
