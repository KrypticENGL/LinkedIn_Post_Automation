"""
Modal service for the LinkedIn post automation's AI work.

Two web endpoints, deployed as one Modal app ("linkedin-ai"):

  POST /generate  (CPU)  - thin proxy in front of Google's Gemini
                           generateContent API. The Node app sends the exact
                           request body it would have sent to Google plus the
                           model name; this returns Gemini's HTTP status and
                           raw response body untouched. All retry, schema and
                           refusal handling stays in src/ai/gemini.ts.

  POST /image     (GPU)  - Stable Diffusion XL image generation, returning PNG
                           bytes. Replaces the pollinations.ai call in
                           src/generation/image.ts.

Both check a shared bearer token so the endpoints are not open to the world.
The Node side treats either endpoint being unreachable as non-fatal: it falls
back to calling Gemini / pollinations directly.

Deploy:  modal deploy modal/ai_proxy.py      (see modal/README.md for secrets)
"""

import io
import os
import time

import modal

app = modal.App("linkedin-ai")

# Both created by `modal secret create` - see modal/README.md.
#   linkedin-ai-auth   -> PROXY_TOKEN    (any long random string; set MODAL_PROXY_TOKEN
#                                         in the Node env to the same value)
#   linkedin-ai-gemini -> GEMINI_API_KEY
auth_secret = modal.Secret.from_name("linkedin-ai-auth")
gemini_secret = modal.Secret.from_name("linkedin-ai-gemini")

GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models"

# --------------------------------------------------------------------------- #
# Text proxy - CPU, cheap, scales to zero.
# --------------------------------------------------------------------------- #

api_image = modal.Image.debian_slim(python_version="3.12").pip_install(
    "fastapi[standard]==0.115.12",
    "httpx==0.28.1",
)


@app.function(
    image=api_image,
    secrets=[auth_secret, gemini_secret],
    timeout=180,
    min_containers=0,
)
@modal.concurrent(max_inputs=40)
@modal.asgi_app()
def generate():
    import httpx
    from fastapi import FastAPI, HTTPException, Request

    web = FastAPI(title="linkedin-ai text proxy")

    def require_token(request: Request) -> None:
        expected = os.environ.get("PROXY_TOKEN", "")
        got = request.headers.get("authorization", "")
        if not expected or got != f"Bearer {expected}":
            raise HTTPException(status_code=401, detail="unauthorized")

    @web.get("/health")
    async def health():
        return {"ok": True, "service": "linkedin-ai", "endpoint": "generate"}

    @web.post("/")
    @web.post("/generate")
    async def proxy(request: Request):
        require_token(request)
        data = await request.json()
        model = data.get("model")
        payload = data.get("payload")
        if not model or payload is None:
            raise HTTPException(status_code=400, detail="model and payload are required")

        try:
            async with httpx.AsyncClient(timeout=170.0) as client:
                r = await client.post(
                    f"{GEMINI_BASE}/{model}:generateContent",
                    headers={
                        "x-goog-api-key": os.environ["GEMINI_API_KEY"],
                        "content-type": "application/json",
                    },
                    json=payload,
                )
        except httpx.HTTPError as exc:
            # Transport-level failure talking to Google - let the Node side fall
            # back to a direct call rather than treat this as a Gemini error.
            raise HTTPException(status_code=502, detail=f"upstream error: {exc}")

        # 200 always: the Node side reads `status` to decide, and needs to tell
        # "Gemini returned 429" apart from "the proxy itself broke" (non-200).
        return {"status": r.status_code, "body": r.text}

    return web


# --------------------------------------------------------------------------- #
# Image generation - GPU, keeps SDXL resident, scales to zero after a few
# minutes idle.
# --------------------------------------------------------------------------- #

# Override at deploy time by editing here (these are read when the file is
# imported by `modal deploy`, i.e. on your machine).
IMAGE_MODEL = os.environ.get(
    "LINKEDIN_AI_IMAGE_MODEL", "stabilityai/stable-diffusion-xl-base-1.0"
)
DEFAULT_STEPS = int(os.environ.get("LINKEDIN_AI_IMAGE_STEPS", "28"))
NEGATIVE_PROMPT = (
    "text, words, letters, captions, watermark, signature, logo, brand mark, "
    "blurry, lowres, jpeg artifacts, deformed, extra limbs, disfigured"
)

sdxl_image = (
    modal.Image.debian_slim(python_version="3.12")
    .pip_install(
        "fastapi[standard]==0.115.12",
        "torch==2.5.1",
        "diffusers==0.31.0",
        "transformers==4.46.3",
        "accelerate==1.1.1",
        "hf-transfer==0.1.8",
    )
    .env({"HF_HUB_ENABLE_HF_TRANSFER": "1"})
)

model_cache = modal.Volume.from_name("linkedin-ai-model-cache", create_if_missing=True)


@app.function(
    image=sdxl_image,
    gpu="L4",
    secrets=[auth_secret],
    volumes={"/cache": model_cache},
    timeout=600,
    scaledown_window=180,
    min_containers=0,
)
@modal.concurrent(max_inputs=2)
@modal.asgi_app()
def image():
    import torch
    from diffusers import StableDiffusionXLPipeline
    from fastapi import FastAPI, HTTPException, Request, Response

    os.environ.setdefault("HF_HOME", "/cache/huggingface")

    pipe = StableDiffusionXLPipeline.from_pretrained(
        IMAGE_MODEL,
        torch_dtype=torch.float16,
        use_safetensors=True,
        variant="fp16",
    ).to("cuda")
    pipe.set_progress_bar_config(disable=True)
    model_cache.commit()

    web = FastAPI(title="linkedin-ai image")

    def require_token(request: Request) -> None:
        expected = os.environ.get("PROXY_TOKEN", "")
        got = request.headers.get("authorization", "")
        if not expected or got != f"Bearer {expected}":
            raise HTTPException(status_code=401, detail="unauthorized")

    @web.get("/health")
    async def health():
        return {
            "ok": True,
            "service": "linkedin-ai",
            "endpoint": "image",
            "model": IMAGE_MODEL,
        }

    @web.post("/")
    @web.post("/image")
    async def render(request: Request):
        require_token(request)
        data = await request.json()
        prompt = (data.get("prompt") or "").strip()
        if not prompt:
            raise HTTPException(status_code=400, detail="prompt is required")

        # SDXL is trained at 1024; clamp so an odd request size can't OOM the card.
        width = max(512, min(int(data.get("width", 1024)), 1024))
        height = max(512, min(int(data.get("height", 1024)), 1024))
        steps = max(1, min(int(data.get("steps", DEFAULT_STEPS)), 50))
        seed = int(data.get("seed", int(time.time())))

        generator = torch.Generator("cuda").manual_seed(seed)
        result = pipe(
            prompt=prompt,
            negative_prompt=NEGATIVE_PROMPT,
            num_inference_steps=steps,
            guidance_scale=6.5,
            width=width,
            height=height,
            generator=generator,
        )

        buffer = io.BytesIO()
        result.images[0].save(buffer, format="PNG")
        return Response(
            content=buffer.getvalue(),
            media_type="image/png",
            headers={"x-image-seed": str(seed), "x-image-model": IMAGE_MODEL},
        )

    return web
