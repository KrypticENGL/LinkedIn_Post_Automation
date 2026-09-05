# Sigmσid

The Telegram Mini App frontend for the LinkedIn post automation bot — a Vite +
React + TypeScript SPA. In production it's served as static files by the main
Express server (see `../src/server.ts`) and launched from the bot's chat menu
button (see `../src/index.ts`).

## Running it locally

This app calls a real backend at `/api/*` (see `../src/miniapp/`), proxied by
Vite in dev (see `vite.config.ts`) to `http://localhost:3000`. That means two
processes need to be running:

```bash
# terminal 1, at the repo root — the API server, real DB, real Gemini
npm run dev:web

# terminal 2, in this directory — the frontend with hot reload
npm run dev
```

**Use `npm run dev:web`, not `npm run dev`, at the repo root.** The regular
`npm run dev` starts the *actual bot*. Locally that runs in polling mode
(`PUBLIC_BASE_URL` isn't https), which calls Telegram's `deleteWebhook()` and
takes over message handling from whatever webhook is currently configured —
i.e. it will disrupt a deployed production bot for as long as it's running.
`dev:web` boots the same Express app and the same `/api` routes against the
same real database, but never touches bot polling or the webhook — it's the
safe way to develop this frontend against real data.

If `/api/*` calls come back as `502`/connection-refused, it's almost always
because nothing is listening on `http://localhost:3000` — start `dev:web`.

## Build

`npm run build` (also run automatically by the root project's own build step)
type-checks and produces `dist/`, which `../src/server.ts` serves directly.
