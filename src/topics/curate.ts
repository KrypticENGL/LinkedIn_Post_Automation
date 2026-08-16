import { z } from "zod";
import { structured } from "../ai/gemini.js";
import { renderProfile } from "../config/clientProfile.js";
import { env } from "../config/env.js";
import type { TopicCandidate } from "../db/schema.js";
import { logger } from "../logger.js";
import { fetchTrendingNews, type NewsItem } from "./news.js";

const topicSchema = z.object({
  topics: z
    .array(
      z.object({
        title: z
          .string()
          .describe("A punchy 4-10 word working title for the post, not a news headline."),
        angle: z
          .string()
          .describe(
            "One or two sentences describing the specific point of view the post should take.",
          ),
        whyNow: z
          .string()
          .describe("One sentence on why this is timely for the client's audience this week."),
        sourceIndexes: z
          .array(z.number().int())
          .describe("Indexes of the supplied headlines this topic draws on. May be empty."),
      }),
    )
    .describe("Distinct topic options, ordered most compelling first."),
});

function renderHeadlines(items: NewsItem[]): string {
  return items
    .map((item, index) => {
      const when = item.publishedAt ? item.publishedAt.toISOString().slice(0, 10) : "undated";
      return `[${index}] ${item.title}\n    publisher: ${item.publisher} | ${when} | query: ${item.query}\n    ${item.summary}`;
    })
    .join("\n");
}

const SYSTEM = `You are the content strategist for a marketing agency's LinkedIn presence.

You are given today's business and marketing headlines. Your job is to turn them into
distinct post topics the agency could credibly own — not to summarise the news.

Rules:
- Each topic must be genuinely different from the others: different theme, different
  angle, different reason to care. Do not produce five variations of one idea.
- Prefer topics where the agency's own expertise gives it something non-obvious to say.
- An angle is a position, not a description. "AI is changing search" is not an angle;
  "Brands optimising for AI answers are quietly abandoning keyword targets" is.
- Skip anything the client profile says to avoid. Skip pure company PR, funding
  announcements with no lesson, and anything politically charged.
- It is fine for a topic to be inspired by the headlines rather than reporting them.`;

export async function curateTopics(count = env.TOPIC_COUNT): Promise<TopicCandidate[]> {
  const headlines = await fetchTrendingNews();

  if (headlines.length === 0) {
    logger.warn("No headlines available; asking for evergreen topics instead");
  }

  const prompt = [
    renderProfile(),
    "",
    `Today is ${new Date().toISOString().slice(0, 10)}.`,
    "",
    headlines.length
      ? `Here are the headlines from the last 48 hours:\n\n${renderHeadlines(headlines)}`
      : "No fresh headlines could be retrieved. Propose timely evergreen topics for this audience instead, and leave sourceIndexes empty.",
    "",
    `Produce exactly ${count} topic options.`,
  ].join("\n");

  const result = await structured({
    label: "topic-curation",
    system: SYSTEM,
    prompt,
    schema: topicSchema,
    maxTokens: 12000,
  });

  const topics: TopicCandidate[] = result.topics.slice(0, count).map((topic) => ({
    title: topic.title,
    angle: topic.angle,
    whyNow: topic.whyNow,
    sources: topic.sourceIndexes
      .map((index) => headlines[index])
      .filter((item): item is NewsItem => Boolean(item))
      .slice(0, 3)
      .map((item) => ({ title: item.title, url: item.url, publisher: item.publisher })),
  }));

  if (topics.length === 0) {
    throw new Error("Topic curation returned no usable topics");
  }

  logger.info({ count: topics.length }, "Curated topic options");
  return topics;
}
