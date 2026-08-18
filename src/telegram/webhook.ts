import { createHash } from "node:crypto";
import { env } from "../config/env.js";

/** Where Telegram delivers updates. Not a secret — the token below is what authenticates. */
export const WEBHOOK_PATH = "/telegram/webhook";

/**
 * Telegram echoes this on every delivery as `X-Telegram-Bot-Api-Secret-Token`, which
 * is what proves an update came from Telegram and not from someone who guessed the
 * URL. Derived from the bot token so there is no second secret to set, rotate, or
 * paste into a dashboard: it changes when the token changes, and it cannot be worked
 * backwards into the token.
 */
export const WEBHOOK_SECRET = createHash("sha256")
  .update(`telegram-webhook:${env.TELEGRAM_BOT_TOKEN}`)
  .digest("hex");

export function webhookUrl(): string {
  return new URL(WEBHOOK_PATH, env.PUBLIC_BASE_URL).toString();
}
