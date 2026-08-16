import { z } from "zod";
import { structured } from "../ai/gemini.js";
import { renderProfile } from "../config/clientProfile.js";
import type { FeedbackEntry, RevisionScope, TopicCandidate } from "../db/schema.js";

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

  return structured({
    label: "post-generation",
    system: SYSTEM,
    prompt,
    schema: postSchema,
    maxTokens: 16000,
  });
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

  return structured({
    label: "post-revision",
    system: SYSTEM,
    prompt,
    schema: postSchema,
    maxTokens: 16000,
  });
}
