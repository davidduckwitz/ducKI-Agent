"""Local image-generation sidecar for the image-gen plugin.

Minimal stdlib HTTP server (no extra web framework) around a diffusers
StableDiffusion*Pipeline. Started on demand by tools/image-gen.js as a child
process and torn down after an idle timeout. Talks JSON over plain HTTP on
127.0.0.1 only - never exposed outside the local machine.

Endpoints:
  GET  /health    -> {"status": "ok", "model_loaded": <model-id-or-null>, "device": "..."}
  POST /generate  -> body {prompt, negative_prompt?, width?, height?, steps?, seed?, model?,
                            reference_image_base64?, strength?}
                      -> {"image_base64": "...", "seed": <int>, "model": "<model-id>"}
                     When reference_image_base64 is given, runs img2img instead of txt2img
                     (edits the reference image guided by the prompt; strength 0-1 controls how
                     much it changes, default 0.6) via AutoPipelineForImage2Image.from_pipe() -
                     reuses the already-loaded txt2img weights, no second model load.
  POST /enhance   -> body {image_base64, action: "upscale"|"sharpen"|"both", scale?, sharpen_amount?}
                      -> {"image_base64": "...", "width": <int>, "height": <int>}
                     Pure PIL post-processing (Lanczos resize + UnsharpMask) - deliberately NOT a
                     learned super-resolution model: no extra model download, runs instantly on
                     CPU, doesn't even need the diffusion pipeline loaded (works before any
                     generate call, or with no GPU at all).

One generation runs at a time (a lock serializes requests) - these are small
turbo models on typically a single local GPU/CPU, not a multi-tenant server.
"""

import argparse
import base64
import io
import json
import math
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MODEL_MAP = {
    "sd-turbo": "stabilityai/sd-turbo",
    "sdxl-turbo": "stabilityai/sdxl-turbo",
    "flux-schnell": "black-forest-labs/FLUX.1-schnell",
}

# Turbo/schnell models are distilled for very few steps with no classifier-free
# guidance; using the normal SD defaults (50 steps, guidance_scale 7.5) would
# both be far slower and produce worse (over-saturated) results.
MODEL_DEFAULTS = {
    "stabilityai/sd-turbo": {"steps": 1, "guidance_scale": 0.0},
    "stabilityai/sdxl-turbo": {"steps": 1, "guidance_scale": 0.0},
    "black-forest-labs/FLUX.1-schnell": {"steps": 4, "guidance_scale": 0.0},
}

_lock = threading.Lock()
_state = {"pipeline": None, "model_id": None, "device": None}
_last_request_at = {"ts": time.time()}


def _resolve_device(requested: str) -> str:
    if requested == "cpu":
        return "cpu"
    try:
        import torch

        if requested == "cuda" or (requested == "auto" and torch.cuda.is_available()):
            return "cuda" if torch.cuda.is_available() else "cpu"
    except Exception:
        return "cpu"
    return "cpu"


def _load_pipeline(model_id: str, device: str):
    if _state["pipeline"] is not None and _state["model_id"] == model_id and _state["device"] == device:
        return _state["pipeline"]

    import torch
    from diffusers import AutoPipelineForText2Image
    from huggingface_hub.utils import LocalEntryNotFoundError

    dtype = torch.float16 if device == "cuda" else torch.float32
    # Once a model is fully cached locally there is no reason to hit huggingface.co on every
    # load just to check for updates/etags - try the cache first, and only fall back to a real
    # network request if something is actually missing (first-ever download, or an incomplete
    # cache). This is what makes repeated use of an already-downloaded model fully offline.
    try:
        sys.stderr.write(f"[image-gen-sidecar] loading '{model_id}' from local cache (offline)...\n")
        pipe = AutoPipelineForText2Image.from_pretrained(model_id, torch_dtype=dtype, local_files_only=True)
    except (LocalEntryNotFoundError, OSError, ValueError):
        if ARGS.offline:
            raise RuntimeError(
                f"'{model_id}' ist nicht vollstaendig im lokalen Cache und OFFLINE_MODE ist aktiv - "
                "kein Zugriff auf huggingface.co erlaubt. Einmal mit OFFLINE_MODE=false generieren, "
                "um das Modell herunterzuladen, dann wieder aktivieren."
            )
        sys.stderr.write(f"[image-gen-sidecar] '{model_id}' not fully cached yet - downloading from huggingface.co...\n")
        pipe = AutoPipelineForText2Image.from_pretrained(model_id, torch_dtype=dtype)
    pipe = pipe.to(device)

    _state["pipeline"] = pipe
    _state["model_id"] = model_id
    _state["device"] = device
    # A stale img2img pipeline built from a now-replaced txt2img pipeline would still work
    # (weights are separate tensors once loaded) but wastes VRAM once the base model changes.
    _img2img_state["pipeline"] = None
    _img2img_state["model_id"] = None
    _img2img_state["device"] = None
    return pipe


# Reference-image (img2img) support: AutoPipelineForImage2Image.from_pipe() reuses the already
# loaded txt2img pipeline's weights/components directly (no extra download, near-zero extra
# VRAM) rather than loading the checkpoint a second time under a different pipeline class.
_img2img_state = {"pipeline": None, "model_id": None, "device": None}


def _load_img2img_pipeline(model_id: str, device: str):
    if (
        _img2img_state["pipeline"] is not None
        and _img2img_state["model_id"] == model_id
        and _img2img_state["device"] == device
    ):
        return _img2img_state["pipeline"]

    from diffusers import AutoPipelineForImage2Image

    base_pipe = _load_pipeline(model_id, device)
    img2img_pipe = AutoPipelineForImage2Image.from_pipe(base_pipe)
    _img2img_state["pipeline"] = img2img_pipe
    _img2img_state["model_id"] = model_id
    _img2img_state["device"] = device
    return img2img_pipe


def _generate(payload: dict) -> dict:
    model_key = str(payload.get("model") or DEFAULT_MODEL_KEY)
    model_id = MODEL_MAP.get(model_key, MODEL_MAP[DEFAULT_MODEL_KEY])
    defaults = MODEL_DEFAULTS.get(model_id, {"steps": 4, "guidance_scale": 0.0})

    prompt = str(payload.get("prompt") or "").strip()
    if not prompt:
        raise ValueError("prompt is required")

    width = int(payload.get("width") or 512)
    height = int(payload.get("height") or 512)
    negative_prompt = payload.get("negative_prompt") or None
    seed = payload.get("seed")
    reference_b64 = payload.get("reference_image_base64") or None
    strength = max(0.05, min(1.0, float(payload.get("strength") or 0.6))) if reference_b64 else None

    steps = int(payload.get("steps") or defaults["steps"])
    guidance_scale = payload.get("guidance_scale")
    guidance_scale = defaults["guidance_scale"] if guidance_scale is None else float(guidance_scale)
    if reference_b64:
        # img2img only actually runs round(steps * strength) denoising steps - a low base step
        # count (turbo/schnell models default to 1-4) combined with a low strength would round to
        # zero steps and diffusers would reject the call, so ensure at least 1 real step happens.
        min_steps = math.ceil(1 / strength)
        steps = max(steps, min_steps)

    device = _resolve_device(ARGS.device)

    import torch

    generator = None
    if seed is not None:
        generator = torch.Generator(device=device).manual_seed(int(seed))
    else:
        seed = int(torch.seed() % (2**31 - 1))
        generator = torch.Generator(device=device).manual_seed(seed)

    kwargs = {
        "prompt": prompt,
        "num_inference_steps": steps,
        "guidance_scale": guidance_scale,
        "generator": generator,
    }
    if negative_prompt and guidance_scale > 0:
        kwargs["negative_prompt"] = negative_prompt

    if reference_b64:
        from PIL import Image

        ref_image = Image.open(io.BytesIO(base64.b64decode(reference_b64))).convert("RGB")
        ref_image = ref_image.resize((width, height), Image.LANCZOS)
        pipe = _load_img2img_pipeline(model_id, device)
        kwargs["image"] = ref_image
        kwargs["strength"] = strength
    else:
        pipe = _load_pipeline(model_id, device)
        kwargs["width"] = width
        kwargs["height"] = height

    result = pipe(**kwargs)
    image = result.images[0]

    buf = io.BytesIO()
    image.save(buf, format="PNG")
    image_base64 = base64.b64encode(buf.getvalue()).decode("ascii")

    return {
        "image_base64": image_base64,
        "seed": seed,
        "model": model_key,
        "steps": steps,
        "guidance_scale": guidance_scale,
    }


def _enhance(payload: dict) -> dict:
    from PIL import Image, ImageFilter

    image_b64 = payload.get("image_base64")
    if not image_b64:
        raise ValueError("image_base64 is required")

    image = Image.open(io.BytesIO(base64.b64decode(image_b64))).convert("RGB")
    action = str(payload.get("action") or "upscale")

    if action in ("upscale", "both"):
        scale = max(1.0, min(4.0, float(payload.get("scale") or 2)))
        new_size = (max(1, round(image.width * scale)), max(1, round(image.height * scale)))
        image = image.resize(new_size, Image.LANCZOS)

    if action in ("sharpen", "both"):
        # radius/threshold are fixed at sane defaults; percent is the one knob exposed to the
        # caller (0 = no effect, ~100-200 = a typical "crisper" amount, higher = more aggressive).
        percent = max(0, min(300, int(payload.get("sharpen_amount") or 150)))
        image = image.filter(ImageFilter.UnsharpMask(radius=2, percent=percent, threshold=3))

    buf = io.BytesIO()
    image.save(buf, format="PNG")
    return {
        "image_base64": base64.b64encode(buf.getvalue()).decode("ascii"),
        "width": image.width,
        "height": image.height,
    }


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        sys.stderr.write("[image-gen-sidecar] " + (fmt % args) + "\n")

    def _send_json(self, status: int, body: dict):
        data = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        _last_request_at["ts"] = time.time()
        if self.path == "/health":
            self._send_json(200, {
                "status": "ok",
                "model_loaded": _state["model_id"],
                "device": _state["device"],
            })
            return
        self._send_json(404, {"error": "not found"})

    def do_POST(self):
        _last_request_at["ts"] = time.time()
        if self.path not in ("/generate", "/enhance"):
            self._send_json(404, {"error": "not found"})
            return

        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length > 0 else b"{}"
        try:
            payload = json.loads(raw.decode("utf-8") or "{}")
        except Exception as exc:
            self._send_json(400, {"error": f"invalid JSON body: {exc}"})
            return

        with _lock:
            try:
                result = _generate(payload) if self.path == "/generate" else _enhance(payload)
                self._send_json(200, result)
            except Exception as exc:  # noqa: BLE001 - report every failure to the caller
                self._send_json(500, {"error": str(exc)})


def _idle_watchdog(max_idle_seconds: float):
    while True:
        time.sleep(15)
        if time.time() - _last_request_at["ts"] > max_idle_seconds:
            sys.stderr.write("[image-gen-sidecar] idle timeout reached, exiting\n")
            sys.exit(0)


DEFAULT_MODEL_KEY = "sd-turbo"
ARGS = None

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--device", default="auto", choices=["auto", "cpu", "cuda"])
    parser.add_argument("--model", default=DEFAULT_MODEL_KEY)
    parser.add_argument("--max-idle-seconds", type=float, default=600)
    parser.add_argument("--offline", action="store_true")
    ARGS = parser.parse_args()
    DEFAULT_MODEL_KEY = ARGS.model if ARGS.model in MODEL_MAP else DEFAULT_MODEL_KEY

    watchdog = threading.Thread(target=_idle_watchdog, args=(ARGS.max_idle_seconds,), daemon=True)
    watchdog.start()

    server = ThreadingHTTPServer(("127.0.0.1", ARGS.port), Handler)
    sys.stderr.write(f"[image-gen-sidecar] listening on 127.0.0.1:{ARGS.port}\n")
    server.serve_forever()
