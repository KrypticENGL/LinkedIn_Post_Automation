import { pingModel } from "./ai/gemini.js";
import { env } from "./config/env.js";
import { countCallsByModel, pingDb } from "./db/repo.js";
import { getConnectedAccount } from "./linkedin/oauth.js";
import { errorMessage } from "./logger.js";
import { startOfDayIn } from "./time.js";

/**
 * Google's free-tier request-per-day counter rolls over at midnight Pacific, regardless
 * of TIMEZONE — so quota "today" is a different day from the one /usage reports.
 */
const QUOTA_TIMEZONE = "America/Los_Angeles";

/** A LinkedIn token this close to expiry is worth re-running /auth for. */
const TOKEN_EXPIRY_WARNING_MS = 7 * 24 * 60 * 60 * 1000;

/** No single check may hold up the reply; Telegram users are watching a spinner. */
const CHECK_TIMEOUT_MS = 12_000;

export type CheckStatus = "ok" | "warn" | "down";

export type Check = {
  name: string;
  status: CheckStatus;
  detail: string;
  /** Round-trip in milliseconds, for checks that made a network or database call. */
  ms?: number;
};

export type ModelQuota = {
  model: string;
  /** Which slot in the failover chain this model occupies. */
  role: "primary" | "fallback";
  usedToday: number;
  usedThisMinute: number;
  perDay: number;
  perMinute: number;
};

export type HealthReport = {
  status: CheckStatus;
  uptimeMs: number;
  checks: Check[];
  quota: {
    models: ModelQuota[];
    /** Milliseconds until the daily counter rolls over. */
    resetsInMs: number;
    timeZone: string;
  };
};

function withTimeout<T>(work: Promise<T>, label: string): Promise<T> {
  return Promise.race([
    work,
    new Promise<never>((_resolve, reject) =>
      setTimeout(() => reject(new Error(`${label} did not respond in ${CHECK_TIMEOUT_MS / 1000}s`)), CHECK_TIMEOUT_MS),
    ),
  ]);
}

/** Runs one probe, timing it, and turns any failure into a "down" row rather than a throw. */
async function timed(name: string, probe: () => Promise<string>): Promise<Check> {
  const startedAt = Date.now();
  try {
    const detail = await withTimeout(probe(), name);
    return { name, status: "ok", detail, ms: Date.now() - startedAt };
  } catch (error) {
    return { name, status: "down", detail: errorMessage(error), ms: Date.now() - startedAt };
  }
}

async function checkLinkedIn(): Promise<Check> {
  try {
    const account = await withTimeout(getConnectedAccount(), "LinkedIn");
    if (!account) {
      // Not an outage — the bot runs fine until it tries to publish.
      return { name: "LinkedIn", status: "warn", detail: "no account connected — run /auth" };
    }

    const remainingMs = account.expiresAt.getTime() - Date.now();
    if (remainingMs <= 0) {
      return { name: "LinkedIn", status: "warn", detail: `token expired — run /auth (${account.memberUrn})` };
    }

    const days = Math.floor(remainingMs / 86_400_000);
    return {
      name: "LinkedIn",
      status: remainingMs < TOKEN_EXPIRY_WARNING_MS ? "warn" : "ok",
      detail: `${account.memberUrn} · token valid ${days}d`,
    };
  } catch (error) {
    return { name: "LinkedIn", status: "down", detail: errorMessage(error) };
  }
}

async function readQuota(): Promise<HealthReport["quota"]> {
  const dayStart = startOfDayIn(QUOTA_TIMEZONE);
  const minuteAgo = new Date(Date.now() - 60_000);

  const [today, thisMinute] = await Promise.all([
    countCallsByModel(dayStart),
    countCallsByModel(minuteAgo),
  ]);

  // The fallback is only listed when it is genuinely a second model.
  const chain: Array<[string, ModelQuota["role"]]> = [[env.GEMINI_MODEL, "primary"]];
  if (env.GEMINI_FALLBACK_MODEL !== env.GEMINI_MODEL) {
    chain.push([env.GEMINI_FALLBACK_MODEL, "fallback"]);
  }

  return {
    models: chain.map(([model, role]) => ({
      model,
      role,
      usedToday: today[model] ?? 0,
      usedThisMinute: thisMinute[model] ?? 0,
      perDay: env.GEMINI_FREE_RPD,
      perMinute: env.GEMINI_FREE_RPM,
    })),
    // Close enough for a countdown: the two DST-shifted days a year are an hour out.
    resetsInMs: dayStart.getTime() + 86_400_000 - Date.now(),
    timeZone: QUOTA_TIMEZONE,
  };
}

/**
 * Probes every dependency the daily run needs, in parallel, and reports quota headroom
 * alongside. Never throws: a failed probe is a result, not an error.
 */
export async function runHealthChecks(): Promise<HealthReport> {
  const [database, gemini, linkedin, quota] = await Promise.all([
    timed("Database", async () => {
      await pingDb();
      return "reachable";
    }),
    timed("Gemini API", async () => {
      await pingModel(env.GEMINI_MODEL);
      return `${env.GEMINI_MODEL} reachable`;
    }),
    checkLinkedIn(),
    readQuota().catch(() => null),
  ]);

  const checks = [database, gemini, linkedin];

  // Quota rides on the same database as the first check, so a null here is already
  // reported by that row — fall back to an empty view rather than a second error.
  const resolvedQuota: HealthReport["quota"] = quota ?? {
    models: [],
    resetsInMs: 0,
    timeZone: QUOTA_TIMEZONE,
  };

  const exhausted = resolvedQuota.models.some((model) => model.usedToday >= model.perDay);
  const status: CheckStatus = checks.some((check) => check.status === "down")
    ? "down"
    : checks.some((check) => check.status === "warn") || exhausted
      ? "warn"
      : "ok";

  return {
    status,
    uptimeMs: process.uptime() * 1000,
    checks,
    quota: resolvedQuota,
  };
}
