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

  IMAGE_PROVIDER: z.enum(["pollinations", "huggingface"]).default("pollinations"),
  IMAGE_WIDTH: z.coerce.number().int().positive().default(1200),
  IMAGE_HEIGHT: z.coerce.number().int().positive().default(1200),
  HUGGINGFACE_API_KEY: z.string().optional(),
  HUGGINGFACE_IMAGE_MODEL: z.string().default("black-forest-labs/FLUX.1-schnell"),

  TELEGRAM_BOT_TOKEN: z.string().min(1, "TELEGRAM_BOT_TOKEN is required"),
  TELEGRAM_CHAT_ID: z.string().min(1, "TELEGRAM_CHAT_ID is required"),

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

export const isProduction = env.NODE_ENV === "production";
