# Modal AI service

Optional. When deployed and wired into the Node env, the AI work runs here instead
of hitting Google / pollinations directly:

| Endpoint      | Runs on | Replaces                                             |
| ------------- | ------- | --------------------------------------------------- |
| `POST /generate` | CPU  | every Gemini `generateContent` call in `src/ai/gemini.ts` (topic curation, drafting, revision, moderation) |
| `POST /image`    | GPU (L4) | the pollinations.ai call in `src/generation/image.ts` — runs Stable Diffusion XL |

`/generate` is a thin proxy: it forwards the exact request body the Node app would
have sent to Google and returns Google's status + body untouched. All retry, schema
validation and refusal handling stays in Node.

Every call to Modal falls back to the direct path on failure, so the service being
down or cold is only a warning (visible in `/test`), never a blocked draft.

## One-time setup

```bash
pip install modal            # needs Python 3.9–3.13
modal token set --token-id <id> --token-secret <secret> --profile=<you>
modal profile activate <you>
```

Create the two secrets the app expects:

```bash
# Shared bearer token both endpoints check. Use a long random string and set the
# Node env var MODAL_PROXY_TOKEN to the SAME value.
modal secret create linkedin-ai-auth PROXY_TOKEN="$(openssl rand -hex 32)"

# The Gemini API key (same one as GEMINI_API_KEY in the Node env).
modal secret create linkedin-ai-gemini GEMINI_API_KEY="AIza..."
```

## Deploy

```bash
modal deploy modal/ai_proxy.py
```

The output prints two URLs, e.g.

```
https://<workspace>--linkedin-ai-generate.modal.run
https://<workspace>--linkedin-ai-image.modal.run
```

Put them in the Node env (`.env`, or Render's dashboard):

```
MODAL_AI_URL=https://<workspace>--linkedin-ai-generate.modal.run
MODAL_IMAGE_URL=https://<workspace>--linkedin-ai-image.modal.run
MODAL_PROXY_TOKEN=<the same value you put in linkedin-ai-auth>
```

Restart the Node app. `/test` in Telegram now shows a **Modal** row.

## Verify

```bash
curl https://<workspace>--linkedin-ai-generate.modal.run/health
curl https://<workspace>--linkedin-ai-image.modal.run/health      # first hit cold-starts the GPU + SDXL (~1–2 min)
```

## Cost notes

- `/generate` is CPU-only and scales to zero — effectively free between drafts.
- `/image` holds an L4 GPU while warm and for `scaledown_window` (180s) after the
  last request, then scales to zero. One draft = one or two renders.
- SDXL weights (~7 GB) are cached in the `linkedin-ai-model-cache` volume after the
  first cold start.

## Changing the image model

Edit `IMAGE_MODEL` / `DEFAULT_STEPS` near the bottom of `ai_proxy.py` and redeploy.
`stabilityai/sdxl-turbo` (set steps to 2–4) trades quality for a much faster render;
`black-forest-labs/FLUX.1-schnell` is higher quality but gated — you'd need to add a
Hugging Face token secret and accept the model licence.
