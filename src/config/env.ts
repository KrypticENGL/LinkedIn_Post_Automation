import "dotenv/config";
import { z } from "zod";

const csv = (value: string) =>
  value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);

const schema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  PUBLIC_BASE_URL: z.string().url().default("http://localhost:3000"),

  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),

  GEMINI_API_KEY: z.string().min(1, "GEMINI_API_KEY is required"),
  GEMINI_MODEL: z.string().default("gemini-3.7-flash"),
  GEMINI_FALLBACK_MODEL: z.string().default("gemini-3.5-flash"),

  // Google exposes no "quota remaining" endpoint, so /test compares the calls this
  // bot recorded against the numbers below. They are per model, and they are only as
  // accurate as you keep them: check your tier's current limits at
  // https://ai.google.dev/gemini-api/docs/rate-limits and adjust if they change.
  GEMINI_FREE_RPM: z.coerce.number().int().positive().default(10),
  GEMINI_FREE_RPD: z.coerce.number().int().positive().default(250),

  IMAGE_PROVIDER: z.enum(["pollinations", "huggingface"]).default("pollinations"),
  IMAGE_WIDTH: z.coerce.number().int().positive().default(1200),
  IMAGE_HEIGHT: z.coerce.number().int().positive().default(1200),
  HUGGINGFACE_API_KEY: z.string().optional(),
  HUGGINGFACE_IMAGE_MODEL: z.string().default("black-forest-labs/FLUX.1-schnell"),

  // Modal (https://modal.com) hosts the AI work when these are set: MODAL_AI_URL
  // proxies every Gemini structured call, MODAL_IMAGE_URL runs SDXL for images.
  // Leave any of them unset and that path stays exactly as before — direct Gemini
  // and pollinations. When Modal is configured but a call to it fails, the code
  // falls back to the direct path rather than failing the draft.
  // Deploy the service from modal/ai_proxy.py — see modal/README.md.
  MODAL_AI_URL: z.string().url().optional(),
  MODAL_IMAGE_URL: z.string().url().optional(),
  /** Shared bearer token both Modal endpoints check; must match the linkedin-ai-auth secret. */
  MODAL_PROXY_TOKEN: z.string().optional(),
  /** SDXL cold start (container boot + weight load) can take a couple of minutes. */
  MODAL_IMAGE_TIMEOUT_MS: z.coerce.number().int().positive().default(210_000),

  TELEGRAM_BOT_TOKEN: z.string().min(1, "TELEGRAM_BOT_TOKEN is required"),
  TELEGRAM_CHAT_ID: z.string().min(1, "TELEGRAM_CHAT_ID is required"),
  /** Leave unset to pick automatically — see `telegramMode` at the bottom of this file. */
  TELEGRAM_MODE: z.enum(["webhook", "polling"]).optional(),

  LINKEDIN_CLIENT_ID: z.string().min(1, "LINKEDIN_CLIENT_ID is required"),
  LINKEDIN_CLIENT_SECRET: z.string().min(1, "LINKEDIN_CLIENT_SECRET is required"),
  LINKEDIN_REDIRECT_URI: z.string().url(),
  LINKEDIN_API_VERSION: z.string().regex(/^\d{6}$/, "LINKEDIN_API_VERSION must look like 202506"),

  TOKEN_ENCRYPTION_KEY: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/, "TOKEN_ENCRYPTION_KEY must be 64 hex characters (32 bytes)"),

  DAILY_CRON: z.string().default("0 9 * * *"),
  TIMEZONE: z.string().default("Asia/Kolkata"),
  TOPIC_COUNT: z.coerce.number().int().min(3).max(8).default(5),
  MAX_REVISIONS: z.coerce.number().int().min(1).max(30).default(8),
  MODERATION_MAX_RETRIES: z.coerce.number().int().min(0).max(5).default(2),
  NEWS_QUERIES: z
    .string()
    .default("digital marketing,brand strategy,AI in marketing,advertising industry,B2B marketing")
    .transform(csv)
    .pipe(z.array(z.string().min(1)).min(1)),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("\n");
  // Fail loudly at boot rather than at 9am when the cron fires.
  throw new Error(`Invalid environment configuration:\n${issues}`);
}

export const env = parsed.data;

if (env.IMAGE_PROVIDER === "huggingface" && !env.HUGGINGFACE_API_KEY) {
  throw new Error("IMAGE_PROVIDER=huggingface requires HUGGINGFACE_API_KEY to be set");
}

if ((env.MODAL_AI_URL || env.MODAL_IMAGE_URL) && !env.MODAL_PROXY_TOKEN) {
  throw new Error("MODAL_AI_URL / MODAL_IMAGE_URL require MODAL_PROXY_TOKEN to be set");
}

export const isProduction = env.NODE_ENV === "production";

/**
 * How Telegram reaches the bot.
 *
 * The two are mutually exclusive at Telegram's end, and long polling allows exactly
 * one poller per token: a second one gets a 409 and the first is dropped. That fires
 * on every deploy, because the replacement instance starts before the old one stops.
 * Webhooks have no such race, but Telegram has to be able to reach the URL — so a
 * laptop on http://localhost falls back to polling.
 */
export const telegramMode: "webhook" | "polling" =
  env.TELEGRAM_MODE ?? (env.PUBLIC_BASE_URL.startsWith("https://") ? "webhook" : "polling");
