import express from "express";
import { webhookCallback } from "grammy";
import { env, telegramMode } from "./config/env.js";
import { consumeState, exchangeCodeForTokens } from "./linkedin/oauth.js";
import { errorMessage, logger } from "./logger.js";
import { bot } from "./telegram/bot.js";
import { notify } from "./telegram/notify.js";
import { WEBHOOK_PATH, WEBHOOK_SECRET } from "./telegram/webhook.js";

function page(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:system-ui,sans-serif;max-width:34rem;margin:4rem auto;padding:0 1rem;line-height:1.6}
code{background:#f2f2f2;padding:.15rem .35rem;border-radius:.25rem}</style></head>
<body><h1>${title}</h1>${body}</body></html>`;
}

export function createServer() {
  const app = express();
  app.use(express.json());

  if (telegramMode === "webhook") {
    // grammY checks the secret header itself and answers 401 when it does not match,
    // so the path can stay readable.
    app.post(
      WEBHOOK_PATH,
      webhookCallback(bot, "express", {
        secretToken: WEBHOOK_SECRET,
        // Telegram redelivers anything it does not get an answer to, and a generation
        // round takes minutes. Answer 200 and let the detached work carry on rather
        // than inviting a duplicate update.
        onTimeout: "return",
        timeoutMilliseconds: 55_000,
      }),
    );
  }

  // Uptime pinger target — keeps a free-tier web service from spinning down.
  app.get("/health", (_req, res) => {
    res.json({ ok: true, uptime: process.uptime(), env: env.NODE_ENV });
  });

  app.get("/oauth/linkedin/callback", async (req, res) => {
    const { code, state, error, error_description: description } = req.query;

    if (typeof error === "string") {
      logger.warn({ error, description }, "LinkedIn OAuth denied");
      res
        .status(400)
        .send(page("Authorisation cancelled", `<p><code>${String(description ?? error)}</code></p>`));
      return;
    }

    if (typeof code !== "string" || typeof state !== "string") {
      res.status(400).send(page("Bad request", "<p>Missing <code>code</code> or <code>state</code>.</p>"));
      return;
    }

    if (!consumeState(state)) {
      res
        .status(400)
        .send(page("Expired link", "<p>That authorisation link expired. Run <code>/auth</code> again.</p>"));
      return;
    }

    try {
      const { memberUrn } = await exchangeCodeForTokens(code);
      res.send(
        page(
          "LinkedIn connected",
          `<p>Posting is now authorised for <code>${memberUrn}</code>.</p><p>You can close this tab and go back to Telegram.</p>`,
        ),
      );
      await notify(`🔗 LinkedIn connected as <code>${memberUrn}</code>.`);
    } catch (err) {
      const reason = errorMessage(err);
      logger.error({ err: reason }, "LinkedIn token exchange failed");
      res.status(500).send(page("Could not connect", `<p><code>${reason}</code></p>`));
    }
  });

  app.use((_req, res) => {
    res.status(404).send(page("Not found", "<p>Nothing here.</p>"));
  });

  return app;
}
