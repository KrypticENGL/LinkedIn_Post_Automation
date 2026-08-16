import { XMLParser } from "fast-xml-parser";
import { env } from "../config/env.js";
import { errorMessage, logger } from "../logger.js";

export type NewsItem = {
  title: string;
  url: string;
  publisher: string;
  publishedAt: Date | null;
  summary: string;
  query: string;
};

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
});

const LOOKBACK_HOURS = 48;
const PER_QUERY_LIMIT = 10;

function stripHtml(input: string): string {
  return input
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function asText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "#text" in value) {
    return String((value as Record<string, unknown>)["#text"] ?? "");
  }
  return "";
}

/** Google News titles arrive as "Headline - Publisher". */
function splitTitle(rawTitle: string, fallbackPublisher: string): { title: string; publisher: string } {
  const separator = rawTitle.lastIndexOf(" - ");
  if (separator > 20 && separator > rawTitle.length - 60) {
    return {
      title: rawTitle.slice(0, separator).trim(),
      publisher: rawTitle.slice(separator + 3).trim() || fallbackPublisher,
    };
  }
  return { title: rawTitle.trim(), publisher: fallbackPublisher };
}

async function fetchQuery(query: string, signal: AbortSignal): Promise<NewsItem[]> {
  const url = new URL("https://news.google.com/rss/search");
  url.searchParams.set("q", `${query} when:2d`);
  url.searchParams.set("hl", "en-US");
  url.searchParams.set("gl", "US");
  url.searchParams.set("ceid", "US:en");

  const response = await fetch(url, {
    signal,
    headers: {
      // Google News RSS returns an empty document to unidentified clients.
      "user-agent": "Mozilla/5.0 (compatible; LinkedInPostAutomation/1.0)",
      accept: "application/rss+xml, application/xml;q=0.9",
    },
  });

  if (!response.ok) {
    throw new Error(`Google News returned ${response.status} for "${query}"`);
  }

  const xml = await response.text();
  const parsed = parser.parse(xml) as {
    rss?: { channel?: { item?: unknown } };
  };

  const rawItems = parsed.rss?.channel?.item;
  const items = Array.isArray(rawItems) ? rawItems : rawItems ? [rawItems] : [];
  const cutoff = Date.now() - LOOKBACK_HOURS * 60 * 60 * 1000;

  const result: NewsItem[] = [];
  for (const raw of items.slice(0, PER_QUERY_LIMIT)) {
    const item = raw as Record<string, unknown>;
    const rawTitle = stripHtml(asText(item.title));
    if (!rawTitle) continue;

    const pubDateText = asText(item.pubDate);
    const publishedAt = pubDateText ? new Date(pubDateText) : null;
    if (publishedAt && !Number.isNaN(publishedAt.valueOf()) && publishedAt.valueOf() < cutoff) {
      continue;
    }

    const { title, publisher } = splitTitle(rawTitle, asText(item.source) || "Unknown");

    result.push({
      title,
      url: asText(item.link),
      publisher,
      publishedAt: publishedAt && !Number.isNaN(publishedAt.valueOf()) ? publishedAt : null,
      summary: stripHtml(asText(item.description)).slice(0, 400),
      query,
    });
  }

  return result;
}

/**
 * Pulls trending business/marketing headlines from Google News RSS.
 * Free, no API key, no rate-limit registration.
 */
export async function fetchTrendingNews(queries: string[] = env.NEWS_QUERIES): Promise<NewsItem[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);

  try {
    const settled = await Promise.allSettled(
      queries.map((query) => fetchQuery(query, controller.signal)),
    );

    const seen = new Set<string>();
    const items: NewsItem[] = [];

    for (const [index, outcome] of settled.entries()) {
      if (outcome.status === "rejected") {
        logger.warn(
          { query: queries[index], err: errorMessage(outcome.reason) },
          "News query failed, continuing with the rest",
        );
        continue;
      }
      for (const item of outcome.value) {
        const key = item.title.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        items.push(item);
      }
    }

    items.sort((a, b) => (b.publishedAt?.valueOf() ?? 0) - (a.publishedAt?.valueOf() ?? 0));
    logger.info({ count: items.length, queries: queries.length }, "Fetched trending headlines");
    return items;
  } finally {
    clearTimeout(timeout);
  }
}
