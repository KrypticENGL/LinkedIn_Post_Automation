import { mkdir } from "node:fs/promises";
import { env } from "./config/env.js";
import { IMAGE_DIR } from "./generation/image.js";
import { errorMessage, logger } from "./logger.js";
import { createServer } from "./server.js";

/**
 * A second entry point for local frontend work: the same Express app as index.ts
 * (real DB, real /api routes), but it never calls bot.start()/setWebhook(), the
 * scheduler, or registerHandlers(). `npm run dev` (index.ts) runs the actual bot —
 * in polling mode locally, that calls deleteWebhook() and starts long-polling,
 * which takes over from whatever webhook Telegram currently has configured (e.g. a
 * deployed production instance). This script exists so `npm run dev` in webapp/ has
 * something to proxy /api to without touching the live bot at all.
 */
async function main(): Promise<void> {
  await mkdir(IMAGE_DIR, { recursive: true });

  const server = createServer().listen(env.PORT);
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  logger.info({ port: env.PORT }, "HTTP server listening (web-only — bot polling/webhook not started)");

  const shutdown = async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
}

main().catch((error) => {
  logger.fatal({ err: errorMessage(error) }, "Fatal startup error");
  process.exit(1);
});
