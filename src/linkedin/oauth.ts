import { randomBytes } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { linkedinTokens } from "../db/schema.js";
import { decryptSecret, encryptSecret } from "../crypto/secretBox.js";
import { env } from "../config/env.js";
import { errorMessage, logger } from "../logger.js";

const AUTHORIZE_URL = "https://www.linkedin.com/oauth/v2/authorization";
const TOKEN_URL = "https://www.linkedin.com/oauth/v2/accessToken";
const USERINFO_URL = "https://api.linkedin.com/v2/userinfo";
const REVOKE_URL = "https://www.linkedin.com/oauth/v2/revoke";

/**
 * `w_member_social` is the self-service "Open Permission" that allows posting to the
 * authenticated member's own feed. `openid profile` is what resolves the person URN.
 */
export const SCOPES = ["openid", "profile", "w_member_social"] as const;

/** Raised when there is no usable LinkedIn credential and the user must re-authorise. */
export class LinkedInAuthRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LinkedInAuthRequiredError";
  }
}

const pendingStates = new Map<string, number>();
const STATE_TTL_MS = 15 * 60 * 1000;

export function buildAuthorizationUrl(): { url: string; state: string } {
  const state = randomBytes(16).toString("hex");
  pendingStates.set(state, Date.now() + STATE_TTL_MS);

  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", env.LINKEDIN_CLIENT_ID);
  url.searchParams.set("redirect_uri", env.LINKEDIN_REDIRECT_URI);
  url.searchParams.set("state", state);
  url.searchParams.set("scope", SCOPES.join(" "));

  return { url: url.toString(), state };
}

export function consumeState(state: string): boolean {
  const expiry = pendingStates.get(state);
  pendingStates.delete(state);
  for (const [key, value] of pendingStates) {
    if (value < Date.now()) pendingStates.delete(key);
  }
  return typeof expiry === "number" && expiry > Date.now();
}

type TokenResponse = {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  refresh_token_expires_in?: number;
  scope?: string;
};

async function postForm(body: Record<string, string>): Promise<TokenResponse> {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
    signal: AbortSignal.timeout(20_000),
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`LinkedIn token endpoint returned ${response.status}: ${text.slice(0, 300)}`);
  }
  return JSON.parse(text) as TokenResponse;
}

async function fetchMemberUrn(accessToken: string): Promise<string> {
  const response = await fetch(USERINFO_URL, {
    headers: { authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    throw new Error(
      `LinkedIn userinfo returned ${response.status}: ${(await response.text()).slice(0, 300)}`,
    );
  }
  const profile = (await response.json()) as { sub?: string };
  if (!profile.sub) throw new Error("LinkedIn userinfo response had no 'sub' claim");
  return `urn:li:person:${profile.sub}`;
}

async function persist(tokens: TokenResponse, memberUrn: string): Promise<void> {
  const now = Date.now();
  await db.insert(linkedinTokens).values({
    memberUrn,
    accessToken: encryptSecret(tokens.access_token),
    refreshToken: tokens.refresh_token ? encryptSecret(tokens.refresh_token) : null,
    expiresAt: new Date(now + tokens.expires_in * 1000),
    refreshExpiresAt: tokens.refresh_token_expires_in
      ? new Date(now + tokens.refresh_token_expires_in * 1000)
      : null,
    scope: tokens.scope ?? SCOPES.join(" "),
  });
}

export async function exchangeCodeForTokens(code: string): Promise<{ memberUrn: string }> {
  const tokens = await postForm({
    grant_type: "authorization_code",
    code,
    client_id: env.LINKEDIN_CLIENT_ID,
    client_secret: env.LINKEDIN_CLIENT_SECRET,
    redirect_uri: env.LINKEDIN_REDIRECT_URI,
  });

  const memberUrn = await fetchMemberUrn(tokens.access_token);
  await persist(tokens, memberUrn);

  logger.info(
    { memberUrn, hasRefreshToken: Boolean(tokens.refresh_token) },
    "Stored LinkedIn credentials",
  );
  return { memberUrn };
}

async function latestToken() {
  const rows = await db
    .select()
    .from(linkedinTokens)
    .orderBy(desc(linkedinTokens.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

const REFRESH_SKEW_MS = 5 * 60 * 1000;

/**
 * Returns a usable access token and the member URN to post as, refreshing in place
 * when the stored access token is close to expiry.
 *
 * LinkedIn only issues refresh tokens to apps approved for them. Without one the
 * access token simply expires (60 days) and the operator must re-run /auth.
 */
export async function getLinkedInCredentials(): Promise<{ accessToken: string; memberUrn: string }> {
  const row = await latestToken();
  if (!row) {
    throw new LinkedInAuthRequiredError("No LinkedIn account is connected yet. Run /auth in the bot.");
  }

  if (row.expiresAt.valueOf() - REFRESH_SKEW_MS > Date.now()) {
    return { accessToken: decryptSecret(row.accessToken), memberUrn: row.memberUrn };
  }

  if (!row.refreshToken) {
    throw new LinkedInAuthRequiredError(
      "The LinkedIn access token expired and no refresh token is available. Run /auth to reconnect.",
    );
  }
  if (row.refreshExpiresAt && row.refreshExpiresAt.valueOf() < Date.now()) {
    throw new LinkedInAuthRequiredError(
      "The LinkedIn refresh token has expired. Run /auth to reconnect.",
    );
  }

  logger.info({ memberUrn: row.memberUrn }, "Refreshing LinkedIn access token");
  const tokens = await postForm({
    grant_type: "refresh_token",
    refresh_token: decryptSecret(row.refreshToken),
    client_id: env.LINKEDIN_CLIENT_ID,
    client_secret: env.LINKEDIN_CLIENT_SECRET,
  });

  const now = Date.now();
  await db
    .update(linkedinTokens)
    .set({
      accessToken: encryptSecret(tokens.access_token),
      refreshToken: tokens.refresh_token ? encryptSecret(tokens.refresh_token) : row.refreshToken,
      expiresAt: new Date(now + tokens.expires_in * 1000),
      refreshExpiresAt: tokens.refresh_token_expires_in
        ? new Date(now + tokens.refresh_token_expires_in * 1000)
        : row.refreshExpiresAt,
      updatedAt: new Date(),
    })
    .where(eq(linkedinTokens.id, row.id));

  return { accessToken: tokens.access_token, memberUrn: row.memberUrn };
}

/**
 * Asks LinkedIn to invalidate a token. Best effort by design: the endpoint answers
 * 200 with an empty body, and any failure here must not stop the local delete —
 * /deauth is the operator saying "let go of this account", and a credential we no
 * longer hold is one we cannot post with.
 */
async function revokeAtLinkedIn(token: string): Promise<boolean> {
  try {
    const response = await fetch(REVOKE_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: env.LINKEDIN_CLIENT_ID,
        client_secret: env.LINKEDIN_CLIENT_SECRET,
        token,
      }).toString(),
      signal: AbortSignal.timeout(20_000),
    });
    if (response.ok) return true;

    logger.warn(
      { status: response.status, body: (await response.text()).slice(0, 300) },
      "LinkedIn refused the token revoke",
    );
    return false;
  } catch (error) {
    logger.warn({ err: errorMessage(error) }, "LinkedIn revoke request failed");
    return false;
  }
}

/**
 * Releases the connected LinkedIn identity: revokes the access token upstream, then
 * deletes every stored credential. Returns null when nothing was connected.
 *
 * The whole table goes, not just the newest row — persist() appends on each /auth,
 * so older rows are still live credentials for the same or a previous member.
 * Reversible: /auth connects an account again from scratch.
 */
export async function disconnectLinkedIn(): Promise<{ memberUrn: string; revoked: boolean } | null> {
  const row = await latestToken();
  if (!row) return null;

  let revoked = false;
  try {
    revoked = await revokeAtLinkedIn(decryptSecret(row.accessToken));
  } catch (error) {
    // Unreadable ciphertext (TOKEN_ENCRYPTION_KEY was rotated) must not leave the
    // operator stuck with a row they cannot clear.
    logger.warn({ err: errorMessage(error) }, "Could not decrypt the stored token to revoke it");
  }

  await db.delete(linkedinTokens);

  logger.info({ memberUrn: row.memberUrn, revoked }, "Released LinkedIn credentials");
  return { memberUrn: row.memberUrn, revoked };
}

export async function getConnectedAccount(): Promise<{ memberUrn: string; expiresAt: Date } | null> {
  const row = await latestToken();
  return row ? { memberUrn: row.memberUrn, expiresAt: row.expiresAt } : null;
}
