# BLUEPRINT.md
## LinkedIn Auto-Post Generator (text + image + human approval)

Status: design draft
Owner: Kryptic

---

## 1. Goal

Generate a LinkedIn post (text + image) from a topic prompt, hold it for
manual approval, and publish to a personal LinkedIn profile only after
explicit confirmation. No unattended posting — the approval step is a
hard requirement, not optional, both for sanity and for staying inside
LinkedIn's ToS around automated activity on a member's behalf.

**Non-goals (v1):**
- Company page posting (`w_organization_social`) — different scope,
  skip for now
- Multi-user / SaaS — single-user, personal tool
- Analytics, scheduling calendars, engagement tracking

---

## 2. High-level flow

```
 ┌────────────┐     ┌──────────────┐     ┌───────────────┐
 │  Trigger    │────▶│  Generate     │────▶│  Generate      │
 │ (manual /   │     │  post text    │     │  image         │
 │  cron)      │     │  (Claude API) │     │  (DALL-E /     │
 └────────────┘     └──────────────┘     │  Stability AI) │
                                           └───────┬────────┘
                                                    ▼
                                          ┌───────────────────┐
                                          │  Save draft to DB   │
                                          │  status = pending    │
                                          └─────────┬─────────┘
                                                    ▼
                                          ┌───────────────────┐
                                          │  Telegram bot sends  │
                                          │  draft + image +     │
                                          │  Approve/Reject btns │
                                          └─────────┬─────────┘
                                       Approve │        │ Reject
                                                ▼        ▼
                                  ┌──────────────┐  ┌───────────┐
                                  │ Post to        │  │ status =   │
                                  │ LinkedIn via   │  │ rejected   │
                                  │ Share API      │  │ (archived) │
                                  └──────┬─────────┘  └───────────┘
                                          ▼
                                  ┌──────────────┐
                                  │ status =       │
                                  │ posted, save    │
                                  │ LinkedIn post ID│
                                  └──────────────┘
```

---

## 3. Tech stack

| Layer | Choice | Notes |
|---|---|---|
| Runtime | Node.js + TypeScript | Matches existing MERN/Postgres experience |
| Web framework | Express (or Fastify) | Minimal REST surface, mostly internal |
| Text generation | Anthropic Claude API | Prompt template: topic, tone, length |
| Image generation | OpenAI DALL-E 3 **or** Stability AI | Pick one, both are single REST calls |
| Approval interface | Telegram Bot API via `grammY` | Inline Approve/Reject buttons |
| Database | PostgreSQL | Hosted on **Neon** or **Supabase** free tier (no 30-day expiry, unlike Render's free Postgres) |
| ORM | Drizzle (or Prisma) | Drizzle preferred — closer to raw SQL |
| LinkedIn auth | `simple-oauth2` | 3-legged OAuth 2.0 |
| LinkedIn posting | Direct REST calls via `axios` | LinkedIn's own SDKs are inconsistent |
| Job/state handling | **Status column + poll**, not BullMQ/Redis | Simpler, avoids Render's ephemeral free Redis wiping in-flight jobs |
| Hosting | Render free/Starter web service | See §7 for caveats and mitigations |
| Secrets | `.env` (dev), Render environment variables (prod) | Encrypt LinkedIn tokens at rest (`pgcrypto` or `libsodium`) |
| Logging | `pino` | Structured logs for debugging pipeline failures |

**Why no Redis/BullMQ in v1:** for a single-user tool generating a
handful of posts a week, a `status` enum column on the `drafts` table
(`pending → approved/rejected → posted`) does the same job as a queue,
without depending on Render's free Redis tier (25MB, in-memory,
wiped on restart). Revisit BullMQ + Redis only if this grows into a
multi-step pipeline with retries/backoff that a status column can't
express cleanly.

---

## 4. Data model

```sql
CREATE TABLE drafts (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  topic_prompt  TEXT NOT NULL,
  post_text     TEXT,
  image_url     TEXT,
  status        TEXT NOT NULL DEFAULT 'pending',
    -- pending | approved | rejected | posted | failed
  linkedin_post_id TEXT,
  telegram_message_id TEXT,
  error_message TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE linkedin_tokens (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  access_token  TEXT NOT NULL,   -- encrypted
  refresh_token TEXT,            -- encrypted
  expires_at    TIMESTAMPTZ NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

---

## 5. LinkedIn integration specifics

1. Create an app in the LinkedIn Developer Portal, link it to a company
   page (a placeholder page works for this).
2. Enable two products:
   - **Share on LinkedIn**
   - **Sign In with LinkedIn using OpenID Connect**
3. Request scope `w_member_social` (self-service "Open Permission" —
   no Partner Program review needed for personal-profile posting).
4. Implement the 3-legged OAuth flow once, store the refresh token,
   refresh access tokens automatically before they expire.
5. Rate limit: ~100 calls/day/member — not a concern at this volume.
6. Note: full Partner Program approval is only required for company
   page posting, Marketing API, or analytics — none of which v1 needs.

---

## 6. Approval workflow (Telegram)

- Bot sends: post text, image, `[Approve]` `[Reject]` inline keyboard
- Callback handler updates `drafts.status`
- On `approved`: call LinkedIn Share API, save `linkedin_post_id`,
  set `status = posted`
- On `rejected`: set `status = rejected`, no further action
- On LinkedIn API failure: set `status = failed`, store `error_message`,
  notify via the same Telegram chat so it doesn't fail silently

**Polling vs. webhook:** prefer long-polling for the bot during
development. In production on Render's free tier, be aware that a
spun-down service isn't running the polling loop either — see §7.

---

## 7. Hosting & deployment

**Recommended for v1 (cheapest reliable setup):**
- App (Express + Telegram bot): Render free web service
- Database: Neon or Supabase free Postgres (persists indefinitely,
  unlike Render's own free Postgres which expires after 30 days)
- No Redis/BullMQ dependency (see §3)

**Known limitation:** Render's free web service spins down after 15
minutes of inactivity (~30-60s cold start on wake). Since the bot needs
to be responsive to Telegram button taps at unpredictable times, this
causes delayed approvals.

**Mitigations, in order of preference:**
1. External uptime pinger (UptimeRobot, cron-job.org) hitting a
   `/health` endpoint every ~10 min to prevent spin-down — free, works,
   slightly against the spirit of the free tier
2. Upgrade to Render's Starter tier (~$7/mo) — removes spin-down
   entirely, cheapest fully-reliable option
3. Self-host on existing infra if uptime matters more than cost

---

## 8. Environment variables

```
ANTHROPIC_API_KEY=
OPENAI_API_KEY=            # or STABILITY_API_KEY
LINKEDIN_CLIENT_ID=
LINKEDIN_CLIENT_SECRET=
LINKEDIN_REDIRECT_URI=
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
DATABASE_URL=
TOKEN_ENCRYPTION_KEY=
```

---

## 9. Folder structure (proposed)

```
/src
  /generation
    text.ts          # Claude API call + prompt template
    image.ts         # DALL-E / Stability API call
  /linkedin
    oauth.ts          # 3-legged OAuth flow, token refresh
    post.ts            # Share API call
  /telegram
    bot.ts             # grammY setup, Approve/Reject handlers
  /db
    schema.ts          # Drizzle schema
    client.ts
  /routes
    health.ts            # for uptime pinger
    oauth-callback.ts
  index.ts
.env.example
docker-compose.yml    # optional, for local dev parity
```

---

## 10. Open questions

- [ ] DALL-E 3 vs. Stability AI — pick based on image style preference
- [ ] Should rejected drafts be regenerated automatically or require a
      new manual trigger?
- [ ] Retry policy for LinkedIn API failures (network vs. auth errors)
- [ ] At what point does status-column polling stop being "good enough"
      and warrant migrating to BullMQ + paid Redis?

---

## 11. Future / v2 ideas

- Web dashboard for inline editing before approval (Next.js)
- Company page posting (`w_organization_social`, requires Partner
  Program review)
- Scheduled batch generation (cron: generate Mondays, review by Friday)
- Post-performance tracking once/if broader API access is approved
