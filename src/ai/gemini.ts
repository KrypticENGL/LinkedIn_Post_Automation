import { z } from "zod";
import { env } from "../config/env.js";
import { logger } from "../logger.js";

const API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

/** Raised when Gemini's safety filters decline to answer at all. */
export class ModelRefusalError extends Error {
  readonly category: string | null;

  constructor(message: string, category: string | null) {
    super(message);
    this.name = "ModelRefusalError";
    this.category = category;
  }
}

export type ImageInput = {
  base64: string;
  mediaType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
};

type Effort = "low" | "medium" | "high" | "xhigh" | "max";

type StructuredOptions<T extends z.ZodTypeAny> = {
  system: string;
  prompt: string;
  schema: T;
  /** Optional image attached to the user turn (used by vision moderation). */
  image?: ImageInput;
  maxTokens?: number;
  effort?: Effort;
  /** Label used in logs only. */
  label: string;
};

/** Gemini exposes four thinking levels; the two highest tiers collapse onto "high". */
const THINKING_LEVEL: Record<Effort, string> = {
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "high",
  max: "high",
};

/**
 * The safety reviewer has to be able to look at unsafe content in order to judge it, so
 * Gemini's own filters are loosened to the most permissive threshold that is reliably
 * available without allowlisting. This application's moderation gate is the real control,
 * and it fails closed — see moderation/index.ts.
 */
const SAFETY_SETTINGS = [
  "HARM_CATEGORY_HARASSMENT",
  "HARM_CATEGORY_HATE_SPEECH",
  "HARM_CATEGORY_SEXUALLY_EXPLICIT",
  "HARM_CATEGORY_DANGEROUS_CONTENT",
].map((category) => ({ category, threshold: "BLOCK_ONLY_HIGH" }));

/**
 * Gemini's `responseSchema` is an OpenAPI 3.0 subset rather than full JSON Schema.
 * Zod still emits a couple of keys it rejects outright, so they are stripped here.
 */
function toGeminiSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(toGeminiSchema);
  if (value === null || typeof value !== "object") return value;

  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key === "$schema" || key === "additionalProperties") continue;
    out[key] = toGeminiSchema(child);
  }
  return out;
}

/**
 * Free-tier quota (429) and capacity (503) errors are routine, not fatal. They are
 * retried with backoff and then failed over to the fallback model, because the safety
 * gate treats an errored check as unsafe — an unretried blip would block a clean draft.
 */
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const ATTEMPTS_PER_MODEL = 3;

class TransientError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "TransientError";
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type GeminiResponse = {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    finishReason?: string;
  }>;
  promptFeedback?: { blockReason?: string };
};

/** finishReason values that mean "the model would not answer", not "the model failed". */
const REFUSAL_REASONS = new Set(["SAFETY", "PROHIBITED_CONTENT", "BLOCKLIST", "SPII"]);

async function generate(
  model: string,
  options: StructuredOptions<z.ZodTypeAny>,
  responseSchema: unknown,
): Promise<GeminiResponse> {
  // The image goes first so the model sees it before the instructions about it.
  const parts: unknown[] = [];
  if (options.image) {
    parts.push({
      inline_data: { mime_type: options.image.mediaType, data: options.image.base64 },
    });
  }
  parts.push({ text: options.prompt });

  const response = await fetch(`${API_BASE}/${model}:generateContent`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      // Header rather than ?key= so the key never lands in a URL or proxy log.
      "x-goog-api-key": env.GEMINI_API_KEY,
    },
    signal: AbortSignal.timeout(120_000),
    body: JSON.stringify({
      contents: [{ role: "user", parts }],
      systemInstruction: { parts: [{ text: options.system }] },
      safetySettings: SAFETY_SETTINGS,
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema,
        maxOutputTokens: options.maxTokens ?? 8000,
        thinkingConfig: { thinkingLevel: THINKING_LEVEL[options.effort ?? "high"] },
      },
    }),
  });

  if (!response.ok) {
    const message = `Gemini ${model} returned ${response.status}: ${(await response.text()).slice(0, 300)}`;
    if (RETRYABLE_STATUS.has(response.status)) {
      throw new TransientError(response.status, message);
    }
    throw new Error(message);
  }

  return (await response.json()) as GeminiResponse;
}

/**
 * Runs a single structured-output request and returns the parsed, schema-validated
 * result. A safety refusal is retried once on the fallback model; anything else is
 * surfaced to the caller.
 */
export async function structured<T extends z.ZodTypeAny>(
  options: StructuredOptions<T>,
): Promise<z.infer<T>> {
  const responseSchema = toGeminiSchema(
    z.toJSONSchema(options.schema, { target: "openapi-3.0", io: "output", reused: "inline" }),
  );

  const models = [env.GEMINI_MODEL, env.GEMINI_FALLBACK_MODEL];
  let lastRefusal: ModelRefusalError | null = null;
  let lastTransient: TransientError | null = null;

  for (const model of models) {
    let body: GeminiResponse | null = null;

    for (let attempt = 1; attempt <= ATTEMPTS_PER_MODEL; attempt += 1) {
      try {
        body = await generate(model, options, responseSchema);
        break;
      } catch (error) {
        if (!(error instanceof TransientError)) throw error;
        lastTransient = error;
        logger.warn(
          { label: options.label, model, attempt, status: error.status },
          "Gemini transient error, retrying",
        );
        // Free-tier quotas reset per minute, so back off in seconds, not milliseconds.
        if (attempt < ATTEMPTS_PER_MODEL) await sleep(attempt * 4000);
      }
    }

    // Every attempt on this model hit a transient error — fail over to the next one.
    if (!body) continue;

    const candidate = body.candidates?.[0];
    const finishReason = candidate?.finishReason;
    const category = body.promptFeedback?.blockReason ?? finishReason ?? null;

    if (body.promptFeedback?.blockReason || (finishReason && REFUSAL_REASONS.has(finishReason))) {
      lastRefusal = new ModelRefusalError(
        `Gemini declined the "${options.label}" request (${category ?? "unspecified"})`,
        category,
      );
      logger.warn({ label: options.label, model, category }, "Gemini refused request");
      continue;
    }

    if (finishReason === "MAX_TOKENS") {
      throw new Error(
        `Gemini hit maxOutputTokens on "${options.label}" — raise maxTokens and retry`,
      );
    }

    const text = (candidate?.content?.parts ?? [])
      .map((part) => part.text ?? "")
      .join("")
      .trim();

    if (!text) {
      throw new Error(
        `Gemini returned no output for "${options.label}" (finishReason: ${finishReason ?? "none"})`,
      );
    }

    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new Error(
        `Gemini returned non-JSON output for "${options.label}": ${text.slice(0, 200)}`,
      );
    }

    // The shape is enforced server-side, but the values are still the model's own.
    return options.schema.parse(payload) as z.infer<T>;
  }

  throw (
    lastRefusal ??
    lastTransient ??
    new Error(`Gemini produced no usable response for "${options.label}"`)
  );
}
