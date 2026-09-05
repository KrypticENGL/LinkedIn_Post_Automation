import { mkdir } from "node:fs/promises";
import { env, telegramMode } from "./config/env.js";
import { clientProfile } from "./config/clientProfile.js";
import { closeDb } from "./db/client.js";
import { IMAGE_DIR } from "./generation/image.js";
import { errorMessage, logger } from "./logger.js";
import { startScheduler } from "./scheduler.js";
import { createServer } from "./server.js";
import { bot } from "./telegram/bot.js";
import { registerHandlers } from "./telegram/handlers.js";
import { WEBHOOK_SECRET, webhookUrl } from "./telegram/webhook.js";

async function main(): Promise<void> {
  await mkdir(IMAGE_DIR, { recursive: true });

  registerHandlers();

  await bot.api.setMyCommands([
    { command: "topics", description: "Fetch today's hot topics" },
    { command: "test", description: "Health check and quota left" },
    { command: "status", description: "What's in flight" },
    { command: "recent", description: "Recent drafts" },
    { command: "usage", description: "Gemini token usage" },
    { command: "model", description: "See or switch the Gemini model" },
    { command: "auth", description: "Connect LinkedIn" },
    { command: "whoami", description: "Show the connected LinkedIn account" },
    { command: "deauth", description: "Release the connected LinkedIn account" },
    { command: "retry", description: "Retry the last failed publish" },
    { command: "cancel", description: "Stop waiting for a reply" },
    { command: "help", description: "How this works" },
  ]);

  // Awaited rather than fired and forgotten: in webhook mode Telegram is told about
  // this URL a few lines below, and a port that turns out to be taken should surface
  // here and not as a silent delivery failure.
  const server = createServer().listen(env.PORT);
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  logger.info({ port: env.PORT, baseUrl: env.PUBLIC_BASE_URL }, "HTTP server listening");

  const scheduler = startScheduler();

  const shutdown = async (signal: string, code = 0) => {
    logger.info({ signal }, "Shutting down");
    scheduler.stop();
    if (telegramMode === "polling") await bot.stop().catch(() => undefined);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await closeDb().catch(() => undefined);
    process.exit(code);
  };

  if (telegramMode === "webhook") {
    // init() up front so botInfo is populated and a bad token fails at boot rather
    // than on the first update.
    await bot.init();
    await bot.api.setWebhook(webhookUrl(), {
      secret_token: WEBHOOK_SECRET,
      allowed_updates: ["message", "callback_query"],
    });

    // Telegram Web Apps require https, which webhook mode already guarantees — so the
    // Mini App menu button only makes sense here, never for local polling. A failure
    // here (e.g. the webapp hasn't been built/deployed yet) shouldn't block startup.
    try {
      await bot.api.setChatMenuButton({
        menu_button: { type: "web_app", text: "Sigmσid", web_app: { url: env.PUBLIC_BASE_URL } },
      });
    } catch (error) {
      logger.warn({ err: errorMessage(error) }, "Could not set the Mini App menu button");
    }

    logger.info(
      { username: bot.botInfo.username, client: clientProfile.clientName, url: webhookUrl() },
      "Telegram bot online (webhook)",
    );
  } else {
    // A webhook left behind by a previous deployment makes getUpdates fail outright,
    // so clear it before polling.
    await bot.api.deleteWebhook();

    // Telegram allows exactly one poller per token and answers 409 to the loser, which
    // is why production uses webhooks. Losing that race is survivable; dying on an
    // unhandled rejection is not, since it skips shutdown and leaves the HTTP server
    // and the database pool to be killed with the process.
    bot
      .start({
        onStart: (info) =>
          logger.info(
            { username: info.username, client: clientProfile.clientName },
            "Telegram bot online (polling)",
          ),
      })
      .catch((error) => {
        logger.fatal({ err: errorMessage(error) }, "Telegram polling stopped");
        void shutdown("polling-failure", 1);
      });
  }

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((error) => {
  logger.fatal({ err: errorMessage(error) }, "Fatal startup error");
  process.exit(1);
});
