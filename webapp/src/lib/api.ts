import type { ActivityEvent, ModelInfo, PostSummary, QuotaReport } from "../data/types";
import { getInitData } from "./telegram";

export class ApiError extends Error {}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const initData = getInitData();
  const headers = new Headers(init?.headers);
  headers.set("Content-Type", "application/json");
  if (initData) headers.set("Authorization", `tma ${initData}`);

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

export const getQuota = () => request<QuotaReport>("/quota");

export type CommandReply = { html: string; url?: string };

/** Runs a bot command for real — see src/miniapp/router.ts's COMMANDS map. */
export const runCommand = (name: string) => request<CommandReply>(`/commands/${name}`, { method: "POST" });

/** Bot→approver messages the server teed from Telegram. Pass the previous `cursor`
 *  as `since` to get only what is new; `since = 0` returns a short catch-up window. */
export const getActivity = (since: number) =>
  request<{ events: ActivityEvent[]; cursor: number }>(`/activity?since=${since}`);
