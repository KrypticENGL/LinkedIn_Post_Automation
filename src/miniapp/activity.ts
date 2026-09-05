/**
 * A short in-memory log of everything the bot has just told the approver — the
 * same HTML it sends to Telegram, teed here so the web app can show it too.
 *
 * Not durable: it keeps only the last {@link MAX} events and resets on restart,
 * since /recent and /status already read real history from the database. The web
 * app polls `GET /api/activity?since=<cursor>` and appends anything newer than
 * the cursor it last saw.
 */

export type ActivityTone = "success" | "error" | "info";

export type ActivityEvent = {
  id: number;
  at: string;
  html: string;
  tone: ActivityTone;
  url?: string;
};

const MAX = 100;
/** How many past events a cold client (since=0) gets, so it doesn't flood on open. */
const COLD_START = 12;

const events: ActivityEvent[] = [];
let nextId = 1;

/** Records one bot→approver message. Call it right before the Telegram send so the
 *  web app still sees the message even if Telegram itself is unreachable. */
export function recordActivity(html: string, tone: ActivityTone = "info", url?: string): ActivityEvent {
  const event: ActivityEvent = { id: nextId++, at: new Date().toISOString(), html, tone, url };
  events.push(event);
  if (events.length > MAX) events.splice(0, events.length - MAX);
  return event;
}

/** Infers a tone from a message's leading glyph — the bot already prefixes its
 *  Telegram messages with one (❗️, 🚀, 🔐, …), so no caller needs to pass a tone. */
export function toneForMessage(html: string): ActivityTone {
  const head = html.trimStart();
  if (/^(❗️|❗|🛑|🚫|🔴|⚠️)/u.test(head)) return "error";
  if (/^(🚀|✅|🟢|🔗)/u.test(head)) return "success";
  return "info";
}

/**
 * Events newer than `since` (an `id` from a previous response). `since <= 0`
 * returns only the last {@link COLD_START} events. `cursor` is the newest id now
 * known — pass it back as `since` next time.
 */
export function activitySince(since: number): { events: ActivityEvent[]; cursor: number } {
  const cursor = nextId - 1;
  if (since > 0) return { events: events.filter((e) => e.id > since), cursor };
  return { events: events.slice(-COLD_START), cursor };
}
