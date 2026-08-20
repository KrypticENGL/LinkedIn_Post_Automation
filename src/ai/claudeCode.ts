import { query } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { env } from "../config/env.js";
import { recordUsage } from "../db/repo.js";
import { errorMessage, logger } from "../logger.js";

/**
 * Post writing runs on a Claude Pro subscription rather than a metered API key.
 *
 * The Agent SDK authenticates from CLAUDE_CODE_OAUTH_TOKEN — a one-year token minted
 * by `claude setup-token` on a machine with a browser. It is an environment variable
 * rather than a credentials file, which is what makes this survive Render's ephemeral
 * filesystem: the token outlives every deploy and cold start.
 *
 * Two traps worth knowing before changing anything here:
 *
 *  - ANTHROPIC_API_KEY outranks the OAuth token in the SDK's credential order. If it
 *    ever leaks into this service's environment, calls silently start billing an API
 *    account instead of the subscription. env.ts refuses to boot in that case.
 *  - `--bare` / bare mode does not read CLAUDE_CODE_OAUTH_TOKEN at all. We get the
 *    same isolation via `settingSources: []` below, which drops CLAUDE.md, project
 *    settings and .mcp.json without touching credential resolution.
 */

/** Raised when the agent returns something other than a completed turn. */
export class ClaudeCodeError extends Error {
  readonly subtype: string;

  constructor(message: string, subtype: string) {
    super(message);
    this.name = "ClaudeCodeError";
    this.subtype = subtype;
  }
}

type StructuredOptions<T extends z.ZodTypeAny> = {
  system: string;
  prompt: string;
  schema: T;
  /** Label used in logs and usage accounting. */
  label: string;
};

/**
 * Books what the turn spent. `modelUsage` is the documented field for accounting —
 * `usage` covers the main loop only. Fire-and-forget for the same reason as the
 * Gemini path: accounting must never fail a generation.
 */
function bookUsage(
  label: string,
  modelUsage: Record<string, { inputTokens: number; outputTokens: number }>,
  ok: boolean,
): void {
  for (const [model, usage] of Object.entries(modelUsage)) {
    void recordUsage({
      label,
      model,
      promptTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      // The subscription reports no separate thinking count; it is folded into output.
      thoughtTokens: 0,
      totalTokens: usage.inputTokens + usage.outputTokens,
      ok,
    }).catch((error) => {
      logger.warn({ label, err: errorMessage(error) }, "Could not record API usage");
    });
  }
}

/**
 * Runs one text-in, JSON-out turn against the subscription and returns the parsed,
 * schema-validated result.
 *
 * Deliberately not an agent: no tools, one turn, no filesystem settings. This is a
 * structured-output call that happens to be reaching the model through the Claude
 * Code harness, and it should stay that way — the moment it grows tool access it also
 * grows a permission surface that a 9am cron cannot answer prompts for.
 */
export async function structured<T extends z.ZodTypeAny>(
  options: StructuredOptions<T>,
): Promise<z.infer<T>> {
  const schema = z.toJSONSchema(options.schema, { io: "output", reused: "inline" }) as Record<
    string,
    unknown
  >;

  // The SDK has no request-timeout option, so the abort signal is the only ceiling.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 180_000);

  try {
    const response = query({
      prompt: options.prompt,
      options: {
        // A plain string replaces Claude Code's coding-agent prompt outright. Do not
        // switch this to the `claude_code` preset: it would drag in a system prompt
        // about editing files and reading repositories, which is not this job.
        systemPrompt: options.system,
        outputFormat: { type: "json_schema", schema },
        model: env.CLAUDE_CODE_MODEL,
        // No tools, one turn: the harness has nothing to do but answer.
        allowedTools: [],
        maxTurns: 1,
        // `[]` is SDK isolation mode — no CLAUDE.md, no .claude/settings.json, no
        // .mcp.json. Without it the bot would load this repo's own dev tooling on
        // every post it writes.
        settingSources: [],
        // Nothing should ever be asked for, but a cron has no one to ask.
        permissionMode: "dontAsk",
        abortController: controller,
      },
    });

    for await (const message of response) {
      if (message.type !== "result") continue;

      if (message.subtype !== "success") {
        bookUsage(options.label, message.modelUsage, false);
        throw new ClaudeCodeError(
          `Claude Code ended the "${options.label}" turn as ${message.subtype}` +
            (message.errors.length ? `: ${message.errors.join("; ").slice(0, 300)}` : ""),
          message.subtype,
        );
      }

      // is_error on a success subtype means the turn ended on an API error, and
      // `result` carries the error text rather than an answer.
      if (message.is_error) {
        bookUsage(options.label, message.modelUsage, false);
        throw new ClaudeCodeError(
          `Claude Code errored on "${options.label}": ${message.result.slice(0, 300)}`,
          "api_error",
        );
      }

      if (message.structured_output === undefined) {
        bookUsage(options.label, message.modelUsage, false);
        throw new ClaudeCodeError(
          `Claude Code returned no structured output for "${options.label}" ` +
            `(stop_reason: ${message.stop_reason ?? "none"})`,
          "no_structured_output",
        );
      }

      bookUsage(options.label, message.modelUsage, true);

      // The shape is enforced by the harness, but the values are still the model's own.
      return options.schema.parse(message.structured_output) as z.infer<T>;
    }

    throw new ClaudeCodeError(
      `Claude Code produced no result message for "${options.label}"`,
      "no_result",
    );
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Liveness probe for /test. There is no metadata endpoint on this path, so the
 * cheapest honest check is the smallest possible real turn — unlike the Gemini ping
 * this does spend tokens, so it is deliberately tiny.
 */
export async function pingClaudeCode(): Promise<void> {
  await structured({
    label: "healthcheck",
    system: "You are a health check. Answer with the single word specified.",
    prompt: 'Reply with {"ok": "ok"}.',
    schema: z.object({ ok: z.string() }),
  });
}
