import { mkdir } from "node:fs/promises";
import { env } from "./config/env.js";
import { clientProfile } from "./config/clientProfile.js";
import { closeDb } from "./db/client.js";
import { IMAGE_DIR } from "./generation/image.js";
import { errorMessage, logger } from "./logger.js";
import { startScheduler } from "./scheduler.js";
import { createServer } from "./server.js";
import { bot } from "./telegram/bot.js";
import { registerHandlers } from "./telegram/handlers.js";

async function main(): Promise<void> {
  await mkdir(IMAGE_DIR, { recursive: true });

  registerHandlers();

  await bot.api.setMyCommands([
    { command: "topics", description: "Fetch today's hot topics" },
    { command: "test", description: "Health check and quota left" },
    { command: "status", description: "What's in flight" },
    { command: "recent", description: "Recent drafts" },
    { command: "usage", description: "Gemini token usage" },
    { command: "auth", description: "Connect LinkedIn" },
    { command: "whoami", description: "Show the connected LinkedIn account" },
    { command: "retry", description: "Retry the last failed publish" },
    { command: "cancel", description: "Stop waiting for a reply" },
    { command: "help", description: "How this works" },
  ]);

  const server = createServer().listen(env.PORT, () => {
    logger.info({ port: env.PORT, baseUrl: env.PUBLIC_BASE_URL }, "HTTP server listening");
  });

  const scheduler = startScheduler();

  // Long polling: the bot is responsive whenever the process is awake.
  void bot.start({
    onStart: (info) =>
      logger.info(
        { username: info.username, client: clientProfile.clientName },
        "Telegram bot online",
      ),
  });

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "Shutting down");
    scheduler.stop();
    await bot.stop().catch(() => undefined);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await closeDb().catch(() => undefined);
    process.exit(0);
  };

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((error) => {
  logger.fatal({ err: errorMessage(error) }, "Fatal startup error");
  process.exit(1);
});
