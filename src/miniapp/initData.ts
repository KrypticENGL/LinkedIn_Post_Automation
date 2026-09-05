import { createHmac } from "node:crypto";
import { env } from "../config/env.js";

export type TelegramWebAppUser = {
  id: number;
  first_name?: string;
  username?: string;
};

/** Telegram recommends rejecting stale init data; a day is generous for a private bot. */
const MAX_INIT_DATA_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Verifies the signature on a Telegram Mini App's `initData` string and returns the
 * embedded user once both the HMAC and the timestamp check out.
 *
 * https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 */
export function verifyInitData(initData: string): TelegramWebAppUser | null {
  if (!initData) return null;

  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return null;
  params.delete("hash");

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");

  const secretKey = createHmac("sha256", "WebAppData").update(env.TELEGRAM_BOT_TOKEN).digest();
  const computedHash = createHmac("sha256", secretKey).update(dataCheckString).digest("hex");
  if (computedHash !== hash) return null;

  const authDate = Number.parseInt(params.get("auth_date") ?? "", 10);
  if (!authDate || Date.now() - authDate * 1000 > MAX_INIT_DATA_AGE_MS) return null;

  const userRaw = params.get("user");
  if (!userRaw) return null;
  try {
    return JSON.parse(userRaw) as TelegramWebAppUser;
  } catch {
    return null;
  }
}
