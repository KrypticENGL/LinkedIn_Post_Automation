import type { ModelQuota, PostSummary, QuotaReport } from "./types";

/**
 * Placeholder data so the UI reads correctly before it is wired to real
 * endpoints. Shapes match src/health.ts and src/db/schema.ts exactly, so
 * swapping this for a fetch("/api/...") call later is a drop-in.
 */

export const MOCK_POSTS: PostSummary[] = [
  {
    id: "d_9f21",
    title: "Why most B2B marketing teams still ship in silos",
    snippet:
      "Ran the numbers on 40 martech launches this quarter — the ones that shipped fastest had one thing in common...",
    status: "posted",
    model: "gemini-3.7-flash",
    revisionCount: 1,
    createdAt: "2026-09-04T09:12:00Z",
  },
  {
    id: "d_9e07",
    title: "The AI-in-marketing hype cycle just hit its trough",
    snippet:
      "Everyone's LinkedIn feed said AI would 10x content output. A year in, here's what actually held up...",
    status: "awaiting_confirmation",
    model: "gemini-3.7-flash",
    revisionCount: 0,
    createdAt: "2026-09-03T09:08:00Z",
  },
  {
    id: "d_9d44",
    title: "Brand strategy is not a slide deck",
    snippet:
      "Three founders told me this week their 'brand strategy' was a Canva deck nobody opened after the offsite...",
    status: "awaiting_feedback",
    model: "gemini-3.5-flash",
    revisionCount: 2,
    createdAt: "2026-09-02T09:05:00Z",
  },
  {
    id: "d_9c19",
    title: "Advertising's next platform shift won't be an app",
    snippet:
      "The last three platform shifts in advertising all rewarded the same trait: distribution before polish...",
    status: "failed",
    model: "gemini-3.7-flash",
    revisionCount: 3,
    createdAt: "2026-09-01T09:10:00Z",
  },
  {
    id: "d_9b02",
    title: "Digital marketing's attribution problem, solved badly",
    snippet:
      "Every attribution model is wrong. Some are wrong in ways that still make you money — here's how to tell which...",
    status: "cancelled",
    model: "gemini-3.7-flash",
    revisionCount: 1,
    createdAt: "2026-08-31T09:06:00Z",
  },
];

export const MOCK_QUOTA_MODELS: ModelQuota[] = [
  {
    model: "gemini-3.7-flash",
    role: "primary",
    usedToday: 42,
    usedThisMinute: 1,
    perDay: 250,
    perMinute: 10,
  },
  {
    model: "gemini-3.5-flash",
    role: "fallback",
    usedToday: 3,
    usedThisMinute: 0,
    perDay: 250,
    perMinute: 10,
  },
];

export const MOCK_QUOTA: QuotaReport = {
  status: "ok",
  models: MOCK_QUOTA_MODELS,
  resetsInMs: 6 * 60 * 60 * 1000 + 12 * 60 * 1000,
  timeZone: "America/Los_Angeles",
};

export const AVAILABLE_MODELS = [
  { id: "gemini-3.7-flash", label: "Gemini 3.7 Flash", note: "default" },
  { id: "gemini-3.7-pro", label: "Gemini 3.7 Pro", note: "higher quality, slower" },
  { id: "gemini-3.5-flash", label: "Gemini 3.5 Flash", note: "fallback" },
];
