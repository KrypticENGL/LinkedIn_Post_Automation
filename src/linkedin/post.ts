import { readFile } from "node:fs/promises";
import { env } from "../config/env.js";
import { logger } from "../logger.js";
import { getLinkedInCredentials } from "./oauth.js";

const REST_BASE = "https://api.linkedin.com/rest";

function headers(accessToken: string): Record<string, string> {
  return {
    authorization: `Bearer ${accessToken}`,
    "linkedin-version": env.LINKEDIN_API_VERSION,
    "x-restli-protocol-version": "2.0.0",
  };
}

/**
 * The Posts API treats a set of characters as little-text control characters and
 * rejects or mangles unescaped ones. `#` is deliberately left alone so hashtags
 * still resolve.
 */
const RESERVED = /([\\|{}@\[\]()<>*_~])/g;

export function escapeCommentary(text: string): string {
  return text.replace(RESERVED, "\\$1");
}

type InitializeUploadResponse = {
  value?: { uploadUrl?: string; image?: string };
};

async function uploadImage(
  accessToken: string,
  memberUrn: string,
  filePath: string,
): Promise<string> {
  const initResponse = await fetch(`${REST_BASE}/images?action=initializeUpload`, {
    method: "POST",
    headers: { ...headers(accessToken), "content-type": "application/json" },
    body: JSON.stringify({ initializeUploadRequest: { owner: memberUrn } }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!initResponse.ok) {
    throw new Error(
      `LinkedIn initializeUpload failed (${initResponse.status}): ${(await initResponse.text()).slice(0, 300)}`,
    );
  }

  const init = (await initResponse.json()) as InitializeUploadResponse;
  const uploadUrl = init.value?.uploadUrl;
  const imageUrn = init.value?.image;
  if (!uploadUrl || !imageUrn) {
    throw new Error("LinkedIn initializeUpload response was missing uploadUrl or image URN");
  }

  const bytes = await readFile(filePath);
  const putResponse = await fetch(uploadUrl, {
    method: "PUT",
    headers: { authorization: `Bearer ${accessToken}` },
    body: new Uint8Array(bytes),
    signal: AbortSignal.timeout(120_000),
  });

  if (!putResponse.ok) {
    throw new Error(
      `LinkedIn image upload failed (${putResponse.status}): ${(await putResponse.text()).slice(0, 300)}`,
    );
  }

  logger.debug({ imageUrn, bytes: bytes.byteLength }, "Uploaded image to LinkedIn");
  return imageUrn;
}

export type PublishInput = {
  postText: string;
  imagePath?: string | null;
  imageAltText?: string | null;
};

export type PublishResult = {
  postUrn: string;
  postUrl: string;
};

/** Creates the post on the authenticated member's own feed. */
export async function publishToLinkedIn(input: PublishInput): Promise<PublishResult> {
  const { accessToken, memberUrn } = await getLinkedInCredentials();

  const body: Record<string, unknown> = {
    author: memberUrn,
    commentary: escapeCommentary(input.postText),
    visibility: "PUBLIC",
    distribution: {
      feedDistribution: "MAIN_FEED",
      targetEntities: [],
      thirdPartyDistributionChannels: [],
    },
    lifecycleState: "PUBLISHED",
    isReshareDisabledByAuthor: false,
  };

  if (input.imagePath) {
    const imageUrn = await uploadImage(accessToken, memberUrn, input.imagePath);
    body.content = {
      media: {
        id: imageUrn,
        altText: (input.imageAltText ?? "").slice(0, 200) || undefined,
      },
    };
  }

  const response = await fetch(`${REST_BASE}/posts`, {
    method: "POST",
    headers: { ...headers(accessToken), "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(45_000),
  });

  if (!response.ok) {
    throw new Error(
      `LinkedIn post creation failed (${response.status}): ${(await response.text()).slice(0, 400)}`,
    );
  }

  const postUrn = response.headers.get("x-restli-id") ?? response.headers.get("x-linkedin-id");
  if (!postUrn) {
    throw new Error("LinkedIn accepted the post but returned no post URN header");
  }

  const activityId = postUrn.split(":").pop() ?? postUrn;
  const postUrl = `https://www.linkedin.com/feed/update/${encodeURIComponent(postUrn)}/`;

  logger.info({ postUrn, activityId }, "Published post to LinkedIn");
  return { postUrn, postUrl };
}
