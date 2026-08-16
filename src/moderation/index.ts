import { z } from "zod";
import { ModelRefusalError, structured } from "../ai/gemini.js";
import { clientProfile } from "../config/clientProfile.js";
import type { ModerationReport } from "../db/schema.js";
import { errorMessage, logger } from "../logger.js";

const verdictSchema = z.object({
  safe: z.boolean().describe("true only if the content is safe to publish as-is."),
  categories: z
    .array(z.string())
    .describe("Short slugs for every problem found. Empty when safe."),
  reason: z
    .string()
    .describe(
      "One or two sentences. When unsafe, quote or point at the exact offending part so it can be fixed.",
    ),
});

const TEXT_SYSTEM = `You are a publication safety reviewer for a marketing agency's LinkedIn account.
You are the last gate before a post goes public under a real person's name.

Fail the content ("safe": false) if it contains any of:
- sexual or suggestive content, nudity, or innuendo  -> category "sexual"
- profanity, slurs, or crude language                 -> category "profanity"
- hateful, demeaning or harassing content about any group or person -> category "hate"
- violence, gore, weapons, or threats                 -> category "violence"
- self-harm, suicide, eating disorders                -> category "self_harm"
- illegal activity, drugs, or instructions for harm   -> category "illegal"
- partisan political or religious advocacy            -> category "political"
- financial, medical or legal advice presented as guidance -> category "regulated_advice"
- statistics, client results, quotes or case studies that are presented as fact but
  are not attributed to a named, checkable source     -> category "fabricated_claims"
- naming or disparaging a specific competitor         -> category "competitor_attack"
- anything on the client's explicit avoid list        -> category "off_brand"
- personal data about a private individual            -> category "privacy"

Judge the content as a reasonable professional audience would read it. Do not fail a
post for being opinionated, blunt, or critical of an idea — those are in scope for
this account. Fail it for being unsafe, unpublishable, or unattributed-as-fact.`;

const IMAGE_SYSTEM = `You are a publication safety reviewer looking at an AI-generated image that is
about to be attached to a LinkedIn post published under a real person's name.

Fail the image ("safe": false) if it contains any of:
- nudity, partial nudity, sexualised bodies or poses   -> category "sexual"
- gore, injury, weapons, violence                       -> category "violence"
- hateful symbols, extremist or political iconography   -> category "hate"
- drugs, alcohol misuse, or other illegal activity      -> category "illegal"
- a recognisable real public figure, or a photorealistic identifiable human face -> category "real_person"
- a real company logo, trademark or brand mark          -> category "trademark"
- disturbing, uncanny or body-horror imagery            -> category "disturbing"
- garbled, misspelled or nonsensical rendered text and lettering, which AI image
  models produce and which looks unprofessional         -> category "garbled_text"

Clean abstract shapes, illustrations, objects, workspaces and non-identifiable stylised
human figures are fine. Do not fail an image merely for being generic or plain.`;

export type ModerationInput = {
  postText: string;
  image?: { base64: string; mediaType: "image/png" | "image/jpeg" | "image/webp" } | null;
};

async function reviewText(postText: string) {
  return structured({
    label: "moderation-text",
    system: TEXT_SYSTEM,
    schema: verdictSchema,
    maxTokens: 6000,
    effort: "medium",
    prompt: [
      `Client's explicit avoid list: ${clientProfile.avoid.join("; ") || "(none)"}`,
      "",
      "Review this LinkedIn post:",
      "<<<POST",
      postText,
      "POST",
    ].join("\n"),
  });
}

async function reviewImage(image: NonNullable<ModerationInput["image"]>, postText: string) {
  return structured({
    label: "moderation-image",
    system: IMAGE_SYSTEM,
    schema: verdictSchema,
    maxTokens: 6000,
    effort: "medium",
    image,
    prompt: [
      "This image will be published alongside the following post:",
      "<<<POST",
      postText.slice(0, 1200),
      "POST",
      "",
      "Review the image itself. Describe what you actually see before deciding.",
    ].join("\n"),
  });
}

/**
 * Runs the NSFW / brand-safety gate over the post text and, when present, the
 * generated image. Both checks run against Gemini; the image check uses vision.
 *
 * A refusal from the model's own safety filters is treated as an unsafe verdict rather
 * than an error — if the model will not even review the content, it does not ship.
 */
export async function moderateDraft(input: ModerationInput): Promise<ModerationReport> {
  const [textOutcome, imageOutcome] = await Promise.allSettled([
    reviewText(input.postText),
    input.image ? reviewImage(input.image, input.postText) : Promise.resolve(null),
  ]);

  const toVerdict = (
    outcome: PromiseSettledResult<z.infer<typeof verdictSchema> | null>,
    kind: string,
  ) => {
    if (outcome.status === "fulfilled") return outcome.value;
    if (outcome.reason instanceof ModelRefusalError) {
      logger.warn({ kind, category: outcome.reason.category }, "Moderation refused; treating as unsafe");
      return {
        safe: false,
        categories: ["classifier_refusal"],
        reason: `The safety classifier declined to review this ${kind}.`,
      };
    }
    // A transport failure is not a safety verdict — fail closed so nothing ships unreviewed.
    logger.error({ kind, err: errorMessage(outcome.reason) }, "Moderation check errored");
    return {
      safe: false,
      categories: ["moderation_error"],
      reason: `The ${kind} safety check could not complete: ${errorMessage(outcome.reason)}`,
    };
  };

  const text = toVerdict(textOutcome, "text") ?? {
    safe: false,
    categories: ["moderation_error"],
    reason: "No text verdict was produced.",
  };
  const image = toVerdict(imageOutcome, "image");

  const report: ModerationReport = {
    safe: text.safe && (image ? image.safe : true),
    checkedAt: new Date().toISOString(),
    text,
    image,
  };

  logger.info(
    { safe: report.safe, textCategories: text.categories, imageCategories: image?.categories ?? [] },
    "Moderation complete",
  );

  return report;
}

/** Human-readable summary used in the Telegram review message. */
export function describeModeration(report: ModerationReport): string {
  if (report.safe) return "✅ Safety check passed (text + image)";

  const lines = ["⚠️ Safety check failed"];
  if (!report.text.safe) {
    lines.push(`• Text — ${report.text.categories.join(", ") || "flagged"}: ${report.text.reason}`);
  }
  if (report.image && !report.image.safe) {
    lines.push(`• Image — ${report.image.categories.join(", ") || "flagged"}: ${report.image.reason}`);
  }
  return lines.join("\n");
}
