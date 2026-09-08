import { env } from "../config/env.js";
import { errorMessage } from "../logger.js";

/**
 * Modal (https://modal.com) optionally sits in front of the AI work — see
 * modal/ai_proxy.py. This module is the Node side of the text proxy plus a shared
 * health probe and circuit breaker; the image endpoint is called straight from
 * generation/image.ts (which reuses the breaker here).
 *
 * Everything is best-effort: when a Modal call fails, callers fall back to talking
 * to Gemini / pollinations directly, so a Modal outage never blocks a draft.
 */

/** Thrown when the proxy itself is the problem (unreachable, misconfigured, 5xx) —
 *  as opposed to Gemini returning an error *through* a working proxy. */
export class ModalUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModalUnavailableError";
  }
}

export const modalTextEnabled = (): boolean =>
  Boolean(env.MODAL_AI_URL && env.MODAL_PROXY_TOKEN);

export const modalImageEnabled = (): boolean =>
  Boolean(env.MODAL_IMAGE_URL && env.MODAL_PROXY_TOKEN);

/* --------------------------------------------------------------- circuit breaker */

// One Modal failure skips Modal entirely for this long, so a Modal outage does not
// make every retry in structured()'s loop (and every image attempt) pay the full
// timeout before falling back.
const COOLDOWN_MS = 60_000;
let cooldownUntil = 0;

export const modalCoolingDown = (): boolean => Date.now() < cooldownUntil;

export function noteModalFailure(): void {
  cooldownUntil = Date.now() + COOLDOWN_MS;
}

export function noteModalSuccess(): void {
  cooldownUntil = 0;
}

/* ------------------------------------------------------------------- text proxy */

function authHeaders(): Record<string, string> {
  return {
    "content-type": "application/json",
    authorization: `Bearer ${env.MODAL_PROXY_TOKEN ?? ""}`,
  };
}

/** `<origin>/health` for whichever POST URL was configured. */
function healthUrl(postUrl: string): string {
  const url = new URL(postUrl);
  url.pathname = "/health";
  url.search = "";
  return url.toString();
}

export type ProxyResult = { status: number; bodyText: string };

/**
 * Forwards one Gemini `generateContent` request through the Modal proxy. Returns
 * the HTTP status and raw body Google produced, untouched — src/ai/gemini.ts reads
 * them exactly as it would a direct response. Throws {@link ModalUnavailableError}
 * when the proxy is the failure (and opens the breaker), so the caller retries
 * against Google directly.
 */
export async function generateViaModal(model: string, payload: unknown): Promise<ProxyResult> {
  if (!env.MODAL_AI_URL || !env.MODAL_PROXY_TOKEN) {
    throw new ModalUnavailableError("Modal AI proxy is not configured");
  }
  if (modalCoolingDown()) {
    throw new ModalUnavailableError("Modal AI proxy is in cooldown after a recent failure");
  }

  let response: Response;
  try {
    response = await fetch(env.MODAL_AI_URL, {
      method: "POST",
      headers: authHeaders(),
      // The proxy allows itself 170s to hear back from Google; give it a little more.
      signal: AbortSignal.timeout(175_000),
      body: JSON.stringify({ model, payload }),
    });
  } catch (error) {
    noteModalFailure();
    throw new ModalUnavailableError(`Modal AI proxy unreachable: ${errorMessage(error)}`);
  }

  if (!response.ok) {
    noteModalFailure();
    const detail = (await response.text().catch(() => "")).slice(0, 200);
    throw new ModalUnavailableError(`Modal AI proxy returned ${response.status}: ${detail}`);
  }

  const data = (await response.json().catch(() => null)) as
    | { status?: unknown; body?: unknown }
    | null;
  if (!data || typeof data.status !== "number" || typeof data.body !== "string") {
    noteModalFailure();
    throw new ModalUnavailableError("Modal AI proxy returned an unexpected response shape");
  }

  noteModalSuccess();
  return { status: data.status, bodyText: data.body };
}

/* ---------------------------------------------------------------------- health */

/**
 * GET /health on every configured Modal endpoint. Used by /test; throws on the
 * first unreachable one so `timed()` records it as a failed check.
 */
export async function pingModal(): Promise<string> {
  const targets: Array<[string, string]> = [];
  if (env.MODAL_AI_URL) targets.push(["text proxy", healthUrl(env.MODAL_AI_URL)]);
  if (env.MODAL_IMAGE_URL) targets.push(["image", healthUrl(env.MODAL_IMAGE_URL)]);
  if (targets.length === 0) throw new Error("Modal is not configured");

  const names = await Promise.all(
    targets.map(async ([name, url]) => {
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) throw new Error(`${name} health ${res.status}`);
      return name;
    }),
  );
  return `${names.join(" + ")} reachable`;
}
