import { z } from "zod";
import { structured as geminiStructured } from "../ai/gemini.js";
import { renderProfile } from "../config/clientProfile.js";
import { env } from "../config/env.js";
import type { FeedbackEntry, RevisionScope, TopicCandidate } from "../db/schema.js";
import { errorMessage, logger } from "../logger.js";

export const MAX_POST_CHARS = 2800; // LinkedIn's hard limit is 3000; leave headroom.

const postSchema = z.object({
  postText: z
    .string()
    .describe(
      "The complete LinkedIn post, ready to publish. Plain text with real line breaks. No markdown, no surrounding quotes.",
    ),
  imagePrompt: z
    .string()
    .describe(
      "A single self-contained prompt for a text-to-image model describing the accompanying visual. Describe the scene, composition, palette and style. Never ask for words, letters, logos or readable text in the image.",
    ),
  imageAltText: z
    .string()
    .describe("Accessible alt text for the image, under 200 characters."),
  rationale: z
    .string()
    .describe("One or two sentences for the reviewer explaining the choices made."),
});

export type GeneratedPost = z.infer<typeof postSchema>;

/**
 * Writing is the one job routed by POST_WRITER — it is where model quality actually
 * shows up in the output, and it is pure text in, JSON out, which is the only shape
 * the subscription path can serve. Curation and moderation stay on Gemini regardless:
 * the safety gate needs vision, and there is no image input on this route.
 *
 * A failed subscription call falls back to Gemini rather than failing the run. The
 * plan's rate limits are shaped for interactive sessions, so a burst of revisions is
 * the likeliest way to run into one — and losing the 9am post to a rate limit would
 * be a worse outcome than a post written by the fallback model.
 */
async function write(
  label: string,
  system: string,
  prompt: string,
): Promise<GeneratedPost> {
  if (env.POST_WRITER === "claude") {
    try {
      // Imported on demand: the Agent SDK is a heavy dependency, and on a 512 MB
      // Render instance there is no reason to hold it in memory when it is switched off.
      const { structured } = await import("../ai/claudeCode.js");
      return await structured({ label, system, prompt, schema: postSchema });
    } catch (error) {
      logger.warn(
        { label, err: errorMessage(error) },
        "Claude Code write failed, falling back to Gemini",
      );
    }
  }

  return geminiStructured({ label, system, prompt, schema: postSchema, maxTokens: 16000 });
}

const SHARED_RULES = `Hard requirements for the post text:
- Between 700 and ${MAX_POST_CHARS} characters. Never exceed ${MAX_POST_CHARS}.
- Open with a first line that earns the "see more" click without being clickbait.
- Short paragraphs separated by blank lines. At most one short list.
- Plain text only. LinkedIn renders no markdown: no **bold**, no headers, no bullet
  characters other than a simple "-" or "•" at the start of a list line.
- Specific over general. Concrete examples, numbers or mechanisms, not platitudes.
- No fabricated statistics, client names, case study results or quotes. If you need a
  number and do not have a sourced one, make the point without it.
- Sound like a person with an opinion, not a press release or a chatbot.

Hard requirements for the image prompt:
- The image is decorative context, not an infographic. Never request text, numbers,
  letters, logos, watermarks or UI chrome inside the image — image models render them
  as garbled nonsense.
- No recognisable real people, no photorealistic faces, nothing NSFW, violent,
  political or medical.
- Keep it to one clear subject with a simple, readable composition.`;

const SYSTEM = `You write LinkedIn posts on behalf of a marketing agency's founder-level account.

${SHARED_RULES}

Return the finished post, not a draft with placeholders or editorial notes.`;

export async function generatePost(topic: TopicCandidate): Promise<GeneratedPost> {
  const sources = topic.sources.length
    ? topic.sources.map((source) => `- ${source.title} (${source.publisher ?? "source"}): ${source.url}`).join("\n")
    : "None supplied — write from the angle alone and do not cite anything.";

  const prompt = [
    renderProfile(),
    "",
    "Today's topic:",
    `Title: ${topic.title}`,
    `Angle: ${topic.angle}`,
    `Why now: ${topic.whyNow}`,
    "",
    "Background sources (for context only, do not quote or link them in the post):",
    sources,
    "",
    "Write the post and the accompanying image prompt.",
  ].join("\n");

  return write("post-generation", SYSTEM, prompt);
}

export type RevisionInput = {
  topic: TopicCandidate;
  currentText: string;
  currentImagePrompt: string;
  currentAltText: string;
  scope: RevisionScope;
  feedback: string;
  history: FeedbackEntry[];
};

const SCOPE_INSTRUCTION: Record<RevisionScope, string> = {
  text: "Revise the post text only. Return the existing image prompt and alt text unchanged, character for character.",
  image: "Revise the image prompt and alt text only. Return the existing post text unchanged, character for character.",
  both: "Revise both the post text and the image prompt.",
};

export async function revisePost(input: RevisionInput): Promise<GeneratedPost> {
  const history = input.history.length
    ? input.history
        .map((entry, index) => `${index + 1}. (${entry.scope}) ${entry.note}`)
        .join("\n")
    : "None — this is the first revision.";

  const prompt = [
    renderProfile(),
    "",
    "Topic:",
    `Title: ${input.topic.title}`,
    `Angle: ${input.topic.angle}`,
    "",
    "Current post text:",
    "<<<POST",
    input.currentText,
    "POST",
    "",
    "Current image prompt:",
    "<<<IMAGE",
    input.currentImagePrompt,
    "IMAGE",
    "",
    `Current alt text: ${input.currentAltText}`,
    "",
    "Earlier rounds of feedback on this draft:",
    history,
    "",
    "The reviewer's newest feedback:",
    "<<<FEEDBACK",
    input.feedback,
    "FEEDBACK",
    "",
    SCOPE_INSTRUCTION[input.scope],
    "",
    "Apply the feedback precisely. Change what was asked for and leave the rest alone —",
    "do not rewrite sections the reviewer did not mention, and do not undo changes from",
    "earlier rounds unless this feedback contradicts them.",
  ].join("\n");

  return write("post-revision", SYSTEM, prompt);
}
