import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { clientProfile } from "../config/clientProfile.js";
import { env } from "../config/env.js";
import { errorMessage, logger } from "../logger.js";

export const IMAGE_DIR = path.resolve(process.cwd(), "storage", "images");

export type GeneratedImage = {
  /** Absolute path on disk. */
  filePath: string;
  bytes: Buffer;
  mediaType: "image/png" | "image/jpeg" | "image/webp";
  provider: string;
};

type Provider = (prompt: string, seed: number) => Promise<{ bytes: Buffer; mediaType: GeneratedImage["mediaType"] }>;

function normaliseMediaType(contentType: string | null): GeneratedImage["mediaType"] {
  if (!contentType) return "image/png";
  if (contentType.includes("jpeg") || contentType.includes("jpg")) return "image/jpeg";
  if (contentType.includes("webp")) return "image/webp";
  return "image/png";
}

/** Free, keyless. Renders synchronously on GET and streams the image back. */
const pollinations: Provider = async (prompt, seed) => {
  const url = new URL(`https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}`);
  url.searchParams.set("width", String(env.IMAGE_WIDTH));
  url.searchParams.set("height", String(env.IMAGE_HEIGHT));
  url.searchParams.set("model", "flux");
  url.searchParams.set("nologo", "true");
  url.searchParams.set("seed", String(seed));

  const response = await fetch(url, {
    signal: AbortSignal.timeout(120_000),
    headers: { accept: "image/*" },
  });

  if (!response.ok) {
    throw new Error(`Pollinations returned ${response.status}: ${(await response.text()).slice(0, 200)}`);
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  return { bytes, mediaType: normaliseMediaType(response.headers.get("content-type")) };
};

/** Free tier of the Hugging Face Inference API (FLUX.1-schnell by default). */
const huggingface: Provider = async (prompt) => {
  const response = await fetch(
    `https://api-inference.huggingface.co/models/${env.HUGGINGFACE_IMAGE_MODEL}`,
    {
      method: "POST",
      signal: AbortSignal.timeout(120_000),
      headers: {
        authorization: `Bearer ${env.HUGGINGFACE_API_KEY}`,
        "content-type": "application/json",
        accept: "image/*",
      },
      body: JSON.stringify({
        inputs: prompt,
        parameters: { width: env.IMAGE_WIDTH, height: env.IMAGE_HEIGHT },
      }),
    },
  );

  if (response.status === 503) {
    // Cold model on the free tier — the caller's retry loop will pick this up.
    throw new Error("Hugging Face model is still loading (503)");
  }
  if (!response.ok) {
    throw new Error(`Hugging Face returned ${response.status}: ${(await response.text()).slice(0, 200)}`);
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  return { bytes, mediaType: normaliseMediaType(response.headers.get("content-type")) };
};

const PROVIDERS: Record<typeof env.IMAGE_PROVIDER, Provider> = { pollinations, huggingface };

/**
 * Appends the client's house style and the "no text in image" guard rails.
 * Image models render requested lettering as garbled glyphs, so this is enforced
 * here as well as in the post-generation prompt.
 */
export function buildImagePrompt(basePrompt: string): string {
  return [
    basePrompt,
    clientProfile.imageStyle,
    "professional editorial quality, balanced composition, soft even lighting",
    "no text, no words, no letters, no numbers, no logos, no watermarks, no captions",
  ].join(". ");
}

const MAX_ATTEMPTS = 3;

export async function generateImage(
  draftId: string,
  revision: number,
  basePrompt: string,
): Promise<GeneratedImage> {
  const provider = PROVIDERS[env.IMAGE_PROVIDER];
  const prompt = buildImagePrompt(basePrompt);

  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      // A fresh seed each attempt so a retry does not reproduce a failed render.
      const seed = Math.floor(Math.random() * 1_000_000);
      const { bytes, mediaType } = await provider(prompt, seed);

      if (bytes.byteLength < 1024) {
        throw new Error(`Image provider returned only ${bytes.byteLength} bytes`);
      }

      await mkdir(IMAGE_DIR, { recursive: true });
      const extension = mediaType === "image/jpeg" ? "jpg" : mediaType === "image/webp" ? "webp" : "png";
      const filePath = path.join(IMAGE_DIR, `${draftId}-r${revision}.${extension}`);
      await writeFile(filePath, bytes);

      logger.info(
        { draftId, revision, provider: env.IMAGE_PROVIDER, bytes: bytes.byteLength },
        "Generated image",
      );
      return { filePath, bytes, mediaType, provider: env.IMAGE_PROVIDER };
    } catch (error) {
      lastError = error;
      logger.warn(
        { draftId, attempt, err: errorMessage(error) },
        "Image generation attempt failed",
      );
      if (attempt < MAX_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 4000));
      }
    }
  }

  throw new Error(`Image generation failed after ${MAX_ATTEMPTS} attempts: ${errorMessage(lastError)}`);
}
