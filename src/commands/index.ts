import { env } from "../config/env.js";
import {
  clearConversationState,
  getActiveGeminiModel,
  listActiveDrafts,
  listRecentDrafts,
  summariseUsage,
} from "../db/repo.js";
import { runHealthChecks, type Check } from "../health.js";
import { buildAuthorizationUrl, disconnectLinkedIn, getConnectedAccount } from "../linkedin/oauth.js";
import { proposeTopics } from "../pipeline/dailyRun.js";
import { retryPublish } from "../pipeline/draftPipeline.js";
import { formatDuration, startOfDayIn } from "../time.js";
import { APPROVER_CHAT_ID } from "../telegram/bot.js";
import { detach, escapeHtml } from "../telegram/notify.js";

/**
 * The business logic and reply text behind every bot command that isn't tied to a
 * specific draft's inline keyboard (those stay in src/telegram/handlers.ts, since
 * "approve/reject this exact message" only makes sense as a Telegram callback). Both
 * src/telegram/handlers.ts (bot.command(...)) and src/miniapp/router.ts (the web app's
 * /api/commands) call these, so the wording and the underlying action are identical
 * everywhere — one HTML string, safe to render as Telegram HTML *and* as browser
 * HTML, since escapeHtml() already neutralises the metacharacters both care about.
 */

export const HELP_MESSAGE = [
  "<b>LinkedIn post automation</b>",
  "",
  `Every day at <code>${env.DAILY_CRON}</code> (${env.TIMEZONE}) I fetch the hottest business and marketing stories, turn them into ${env.TOPIC_COUNT} topic options, and ask you to pick one.`,
  "",
  "Then: I write the post, generate an image, run both through a safety check, and send them here for approval. Nothing reaches LinkedIn without your explicit confirmation.",
  "",
  "<b>Commands</b>",
  "/topics — fetch today's hot topics now",
  "/test — is the backend live, and how much quota is left",
  "/status — what's in flight",
  "/recent — the last few drafts",
  "/usage — Gemini token usage",
  "/model — see or switch which Gemini model is in use",
  "/auth — connect or reconnect LinkedIn",
  "/whoami — which LinkedIn account is connected",
  "/deauth — release the connected LinkedIn account",
  "/retry — retry publishing the last failed draft",
  "/cancel — stop waiting for a reply from me",
].join("\n");

export function runTopics(): string {
  detach("Topic scan", proposeTopics());
  return "On it.";
}

export async function buildStatusMessage(): Promise<string> {
  const active = await listActiveDrafts();
  if (active.length === 0) return "Nothing in flight. Use /topics to start something.";
  const lines = active.map(
    (draft) => `• <b>${escapeHtml(draft.topicTitle)}</b>\n  ${draft.status} · revision ${draft.revisionCount}`,
  );
  return ["<b>In flight</b>", ...lines].join("\n");
}

export async function buildRecentMessage(): Promise<string> {
  const recent = await listRecentDrafts(5);
  if (recent.length === 0) return "No drafts yet.";
  const lines = recent.map((draft) => {
    const when = draft.createdAt.toISOString().slice(0, 16).replace("T", " ");
    return `• ${when} — <b>${escapeHtml(draft.topicTitle)}</b> (${draft.status})`;
  });
  return lines.join("\n");
}

export async function buildUsageMessage(): Promise<string> {
  const [summary, activeModel] = await Promise.all([
    summariseUsage(startOfDayIn(env.TIMEZONE)),
    getActiveGeminiModel(),
  ]);

  if (summary.allTime.calls === 0) return "No Gemini calls recorded yet. Run /topics to make one.";

  const n = (value: number) => value.toLocaleString("en-US");
  const line = (name: string, w: typeof summary.today) =>
    `${name}: <b>${n(w.calls)}</b> call${w.calls === 1 ? "" : "s"}, ${n(w.totalTokens)} tokens` +
    (w.failed > 0 ? ` (${n(w.failed)} failed)` : "");

  const lines = [
    "<b>Gemini usage</b>",
    `Model: <code>${escapeHtml(activeModel ?? env.GEMINI_MODEL)}</code>` +
      (activeModel ? " (switched via /model)" : "") +
      " · free tier, no billing",
    "",
    line("Last hour", summary.lastHour),
    line(`Today (${escapeHtml(env.TIMEZONE)})`, summary.today),
    line("Last 7 days", summary.last7Days),
    line("All time", summary.allTime),
  ];

  if (summary.byLabel.length > 0) {
    lines.push("", "<b>By step, last 7 days</b>");
    for (const row of summary.byLabel) {
      lines.push(
        `• <code>${escapeHtml(row.label)}</code> — ${n(row.calls)} × ` +
          `${n(row.promptTokens)} in / ${n(row.outputTokens)} out`,
      );
    }
  }

  if (summary.since) {
    lines.push("", `<i>Counting since ${summary.since.toISOString().slice(0, 16).replace("T", " ")} UTC</i>`);
  }

  return lines.join("\n");
}

export async function buildTestMessage(): Promise<string> {
  const report = await runHealthChecks();

  const n = (value: number) => value.toLocaleString("en-US");
  const HEADLINE = {
    ok: "🟢 <b>All systems go</b>",
    warn: "🟡 <b>Up, with warnings</b>",
    down: "🔴 <b>Something is down</b>",
  } as const;
  const ICON = { ok: "✅", warn: "⚠️", down: "❌" } as const;

  const checkLine = (check: Check) =>
    `${ICON[check.status]} <b>${escapeHtml(check.name)}</b> — ${escapeHtml(check.detail)}` +
    (check.ms === undefined ? "" : ` <i>(${n(check.ms)} ms)</i>`);

  const lines = [
    HEADLINE[report.status],
    `Up ${formatDuration(report.uptimeMs)} · ${escapeHtml(process.version)} · ${escapeHtml(env.NODE_ENV)}`,
    "",
    ...report.checks.map(checkLine),
  ];

  if (report.quota.models.length > 0) {
    lines.push("", "<b>Gemini quota left</b>");
    for (const model of report.quota.models) {
      const perDayLeft = Math.max(0, model.perDay - model.usedToday);
      const perMinuteLeft = Math.max(0, model.perMinute - model.usedThisMinute);
      const mark = perDayLeft === 0 ? "⚠️ " : "";
      lines.push(
        `${mark}• <code>${escapeHtml(model.model)}</code>${model.role === "fallback" ? " <i>(fallback)</i>" : ""}\n` +
          `  <b>${n(perDayLeft)}</b> of ${n(model.perDay)} requests left today · ` +
          `<b>${n(perMinuteLeft)}</b> of ${n(model.perMinute)} left this minute`,
      );
    }
    lines.push(
      `<i>Resets in ${formatDuration(report.quota.resetsInMs)} (midnight ${escapeHtml(report.quota.timeZone)}).</i>`,
      "<i>Counted from calls this bot recorded against the limits in GEMINI_FREE_RPD/RPM — " +
        "Google publishes no quota endpoint, so treat it as a floor, not a guarantee.</i>",
    );
  }

  return lines.join("\n");
}

export async function buildWhoamiMessage(): Promise<string> {
  const account = await getConnectedAccount();
  if (!account) return "No LinkedIn account connected. Run /auth.";
  return `Connected as <code>${escapeHtml(account.memberUrn)}</code>\nToken valid until ${account.expiresAt.toISOString()}`;
}

export function runAuth(): { text: string; url: string } {
  const { url } = buildAuthorizationUrl();
  const text = [
    "Open this link and approve access for the LinkedIn profile that should be posting:",
    "",
    url,
    "",
    "The link is valid for 15 minutes.",
  ].join("\n");
  return { text, url };
}

export async function buildDeauthMessage(): Promise<string> {
  const released = await disconnectLinkedIn();
  if (!released) return "No LinkedIn account is connected, so there is nothing to release.";
  return [
    `Released <code>${escapeHtml(released.memberUrn)}</code>.`,
    released.revoked
      ? "The token is revoked at LinkedIn and deleted here."
      : [
          "The token is deleted here, but LinkedIn would not revoke it.",
          "Remove the app under LinkedIn → Settings → Data privacy → Permitted services",
          "to be sure.",
        ].join(" "),
    "",
    "Nothing can be published until you run /auth again.",
  ].join("\n");
}

export async function runRetry(): Promise<string> {
  const recent = await listRecentDrafts(10);
  const failed = recent.find((draft) => draft.status === "failed");
  if (!failed) return "No failed draft to retry.";
  detach("Retry publish", retryPublish(failed.id));
  return `Retrying: ${escapeHtml(failed.topicTitle)}`;
}

export async function runCancel(): Promise<string> {
  await clearConversationState(APPROVER_CHAT_ID);
  return "Fine — I've stopped waiting for a reply.";
}
