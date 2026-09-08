import type {
  ActivityEvent,
  DraftStatus,
  LatestDraft,
  ModelInfo,
  PostSummary,
  QuotaReport,
  ReviewDraft,
  ReviewState,
  RevisionScope,
} from "../data/types";
import { getInitData } from "./telegram";

export class ApiError extends Error {}

function authHeaders(base?: HeadersInit): Headers {
  const headers = new Headers(base);
  const initData = getInitData();
  if (initData) headers.set("Authorization", `tma ${initData}`);
  return headers;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = authHeaders(init?.headers);
  headers.set("Content-Type", "application/json");

  const res = await fetch(`/api${path}`, { ...init, headers });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new ApiError(body?.error ?? `Request failed (${res.status})`);
  }
  return res.json() as Promise<T>;
}

export const getModel = () => request<ModelInfo>("/model");

export const setModel = (model: string) =>
  request<ModelInfo>("/model", { method: "POST", body: JSON.stringify({ model }) });

export const listPosts = (limit = 10) => request<{ posts: PostSummary[] }>(`/posts?limit=${limit}`);

export const createPost = (topic: string) =>
  request<{ ok: true }>("/posts", { method: "POST", body: JSON.stringify({ topic }) });

/** Full text of the most recent draft — 404s (thrown as ApiError) when there is none. */
export const getLatestDraft = () => request<LatestDraft>("/posts/latest");

/** Sends finished post text straight into the review/publish loop — no AI writing pass. */
export const sendComposedPost = (postText: string) =>
  request<{ ok: true }>("/posts/from-text", { method: "POST", body: JSON.stringify({ postText }) });

export const getQuota = () => request<QuotaReport>("/quota");

export type CommandReply = { html: string; url?: string };

/** Runs a bot command for real — see src/miniapp/router.ts's COMMANDS map. */
export const runCommand = (name: string) => request<CommandReply>(`/commands/${name}`, { method: "POST" });

/** Bot→approver messages the server teed from Telegram. Pass the previous `cursor`
 *  as `since` to get only what is new; `since = 0` returns a short catch-up window. */
export const getActivity = (since: number) =>
  request<{ events: ActivityEvent[]; cursor: number }>(`/activity?since=${since}`);

/* -------------------------------------------------------------------- review */

/** The current pick-a-topic buttons and/or the draft awaiting review. */
export const getReview = () => request<ReviewState>("/review");

export const scanTopics = () => request<{ ok: true }>("/topics/scan", { method: "POST" });

export const refreshTopics = (batchId: string) =>
  request<{ ok: true }>(`/topics/${batchId}/refresh`, { method: "POST" });

export const pickTopic = (batchId: string, index: number) =>
  request<{ ok: true }>(`/topics/${batchId}/pick`, {
    method: "POST",
    body: JSON.stringify({ index }),
  });

export const submitCustomTopic = (batchId: string, angle: string) =>
  request<{ ok: true }>(`/topics/${batchId}/custom`, {
    method: "POST",
    body: JSON.stringify({ angle }),
  });

export const approveDraft = (id: string) =>
  request<{ draft: ReviewDraft }>(`/drafts/${id}/approve`, { method: "POST" });

export const sendDraftBackToReview = (id: string) =>
  request<{ draft: ReviewDraft }>(`/drafts/${id}/back`, { method: "POST" });

export const confirmDraft = (id: string) =>
  request<{ ok: true }>(`/drafts/${id}/confirm`, { method: "POST" });

export const reviseDraft = (id: string, scope: RevisionScope, feedback: string) =>
  request<{ ok: true }>(`/drafts/${id}/revise`, {
    method: "POST",
    body: JSON.stringify({ scope, feedback }),
  });

export const cancelDraft = (id: string) =>
  request<{ draft: ReviewDraft }>(`/drafts/${id}/cancel`, { method: "POST" });

export type DraftText = {
  id: string;
  title: string;
  postText: string;
  status: DraftStatus;
  hasImage: boolean;
};

/** One draft's text and state — the Post editor loads this when opened with ?draft. */
export const getDraftById = (id: string) => request<DraftText>(`/drafts/${id}`);

/**
 * Publish an approved draft with hand-edited text. Re-runs the text safety gate:
 * `{ published: true }` (202) means it's on its way to LinkedIn; `{ published:
 * false, reason }` (200) means the edit was blocked and nothing went out.
 */
export const publishEditedDraft = (id: string, postText: string) =>
  request<{ published: boolean; reason?: string }>(`/drafts/${id}/publish`, {
    method: "POST",
    body: JSON.stringify({ postText }),
  });

/**
 * Fetches a draft image (auth header and all) and hands back an object URL.
 * `url` is the full `/api/...` path from ReviewDraft.imageUrl. Caller revokes.
 */
export async function fetchImageObjectUrl(url: string): Promise<string> {
  const res = await fetch(url, { headers: authHeaders() });
  if (!res.ok) throw new ApiError(`Image failed (${res.status})`);
  return URL.createObjectURL(await res.blob());
}
