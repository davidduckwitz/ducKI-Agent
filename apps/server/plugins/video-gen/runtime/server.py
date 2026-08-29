"""Local video-generation sidecar for the video-gen plugin.

Minimal stdlib HTTP server (no extra web framework) around one of several diffusers
text-to-video pipelines (Wan2.1, LTX-Video, HunyuanVideo, CogVideoX). Started on demand
by tools/video-gen.js as a child process and torn down after an idle timeout. Talks JSON
over plain HTTP on 127.0.0.1 only - never exposed outside the local machine. Sibling of
image-gen's runtime/server.py - same lifecycle/venv/setup pattern, adapted for video.

Endpoints:
  GET  /health    -> {"status": "ok", "model_loaded": <model-key-or-null>, "device": "..."}
  POST /generate  -> body {prompt, negative_prompt?, width?, height?, num_frames?, fps?,
                            steps?, guidance_scale?, seed?, model?}
                      -> {"video_base64": "<mp4 bytes, base64>", "seed": <int>, "model": "<key>",
                          "num_frames": <int>, "fps": <int>, "steps": <int>,
                          "guidance_scale": <float>, "width": <int>, "height": <int>}

These are all considerably heavier than the small SD-Turbo-class image models this plugin's
sibling (image-gen) uses - tens of frames of video at once means several GB of VRAM at minimum,
and CPU-only generation is impractical (minutes-to-hours per clip, not seconds). Model defaults
below (resolution/frame-count/steps/guidance) are the commonly published starting points for
each model as of when this was written - if a newer checkpoint under the same repo id changes
its recommended settings, override via the request body rather than editing these.

One generation runs at a time (a lock serializes requests) - same reasoning as image-gen: a
single local GPU/CPU, not a multi-tenant server.
"""

import argparse
import base64
import io
import json
import os
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MODEL_MAP = {
    "wan2.1-1.3b": "Wan-AI/Wan2.1-T2V-1.3B-Diffusers",
    "ltx-video": "Lightricks/LTX-Video",
    "hunyuanvideo": "tencent/HunyuanVideo",
    "cogvideox-2b": "THUDM/CogVideoX-2b",
}

# Which diffusers pipeline class loads each model - the four families need different pipeline
# classes and slightly different calling conventions, diffusers has no single "AutoPipeline" that
# covers all text-to-video models the way AutoPipelineForText2Image does for images.
MODEL_FAMILY = {
    "wan2.1-1.3b": "wan",
    "ltx-video": "ltx",
    "hunyuanvideo": "hunyuan",
    "cogvideox-2b": "cogvideox",
}

# Best-effort published defaults per model (resolution, frame count, fps, steps, guidance) -
# these determine clip length (num_frames / fps = seconds) and quality/speed tradeoff. All
# overridable per request.
MODEL_DEFAULTS = {
    "wan2.1-1.3b": {"width": 832, "height": 480, "num_frames": 81, "fps": 15, "steps": 50, "guidance_scale": 5.0},
    "ltx-video": {"width": 704, "height": 480, "num_frames": 121, "fps": 24, "steps": 50, "guidance_scale": 3.0},
    "hunyuanvideo": {"width": 960, "height": 544, "num_frames": 129, "fps": 24, "steps": 50, "guidance_scale": 6.0},
    "cogvideox-2b": {"width": 720, "height": 480, "num_frames": 49, "fps": 8, "steps": 50, "guidance_scale": 6.0},
}

_lock = threading.Lock()
_state = {"pipeline": None, "model_key": None, "device": None}
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


def _load_pipeline(model_key: str, device: str):
    if _state["pipeline"] is not None and _state["model_key"] == model_key and _state["device"] == device:
        return _state["pipeline"]

    if model_key not in MODEL_MAP:
        raise ValueError(f"unknown model '{model_key}'")

    import torch

    repo_id = MODEL_MAP[model_key]
    family = MODEL_FAMILY[model_key]
    # bfloat16 is what all four model cards recommend on GPU; float32 is the safe (slow) CPU
    # fallback - float16 is deliberately avoided here, several of these models are unstable in it.
    dtype = torch.bfloat16 if device == "cuda" else torch.float32

    def _from_pretrained(pipeline_cls, **extra_kwargs):
        try:
            sys.stderr.write(f"[video-gen-sidecar] loading '{repo_id}' from local cache (offline)...\n")
            return pipeline_cls.from_pretrained(repo_id, torch_dtype=dtype, local_files_only=True, **extra_kwargs)
        except Exception as exc:
            from huggingface_hub.utils import LocalEntryNotFoundError

            if not isinstance(exc, (LocalEntryNotFoundError, OSError, ValueError)):
                raise
            if ARGS.offline:
                raise RuntimeError(
                    f"'{repo_id}' ist nicht vollstaendig im lokalen Cache und OFFLINE_MODE ist aktiv - "
                    "kein Zugriff auf huggingface.co erlaubt. Einmal mit OFFLINE_MODE=false generieren "
                    "(oder action='install_model' verwenden), um das Modell herunterzuladen."
                ) from exc
            sys.stderr.write(f"[video-gen-sidecar] '{repo_id}' not fully cached yet - downloading from huggingface.co...\n")
            return pipeline_cls.from_pretrained(repo_id, torch_dtype=dtype, **extra_kwargs)

    if family == "cogvideox":
        from diffusers import CogVideoXPipeline

        pipe = _from_pretrained(CogVideoXPipeline)
    elif family == "wan":
        from diffusers import WanPipeline

        pipe = _from_pretrained(WanPipeline)
    elif family == "ltx":
        from diffusers import LTXPipeline

        pipe = _from_pretrained(LTXPipeline)
    elif family == "hunyuan":
        from diffusers import HunyuanVideoPipeline

        pipe = _from_pretrained(HunyuanVideoPipeline)
    else:
        raise ValueError(f"unknown model family '{family}'")

    if device == "cuda":
        # Offloads submodules between GPU/CPU as needed instead of keeping the whole (multi-GB)
        # pipeline resident in VRAM at once - what makes these models fit on consumer GPUs at
        # all. Do NOT also call pipe.to("cuda") - offload manages placement itself.
        pipe.enable_model_cpu_offload()
    else:
        pipe = pipe.to(device)

    # Reduce peak VRAM further during VAE decode - supported by all four pipelines' VAEs.
    for method in ("enable_tiling", "enable_slicing"):
        try:
            getattr(pipe.vae, method)()
        except Exception:
            pass

    _state["pipeline"] = pipe
    _state["model_key"] = model_key
    _state["device"] = device
    return pipe


def _generate(payload: dict) -> dict:
    model_key = str(payload.get("model") or DEFAULT_MODEL_KEY)
    if model_key not in MODEL_MAP:
        model_key = DEFAULT_MODEL_KEY
    defaults = MODEL_DEFAULTS[model_key]

    prompt = str(payload.get("prompt") or "").strip()
    if not prompt:
        raise ValueError("prompt is required")

    width = int(payload.get("width") or defaults["width"])
    height = int(payload.get("height") or defaults["height"])
    num_frames = int(payload.get("num_frames") or defaults["num_frames"])
    fps = int(payload.get("fps") or defaults["fps"])
    steps = int(payload.get("steps") or defaults["steps"])
    guidance_scale = payload.get("guidance_scale")
    guidance_scale = defaults["guidance_scale"] if guidance_scale is None else float(guidance_scale)
    negative_prompt = payload.get("negative_prompt") or None
    seed = payload.get("seed")

    device = _resolve_device(ARGS.device)
    pipe = _load_pipeline(model_key, device)

    import torch

    seed = int(seed) if seed is not None else int(torch.seed() % (2**31 - 1))
    # A CPU generator is used deliberately even with a CUDA pipeline - enable_model_cpu_offload()
    # moves submodules across devices during the call, and a CUDA generator can end up on the
    # wrong device mid-pipeline; every one of these model cards uses a CPU generator by convention.
    generator = torch.Generator(device="cpu").manual_seed(seed)

    kwargs = {
        "prompt": prompt,
        "height": height,
        "width": width,
        "num_frames": num_frames,
        "num_inference_steps": steps,
        "guidance_scale": guidance_scale,
        "generator": generator,
    }
    if negative_prompt:
        kwargs["negative_prompt"] = negative_prompt

    output = pipe(**kwargs)
    frames = output.frames[0]

    from diffusers.utils import export_to_video

    tmp_fd, tmp_path = tempfile.mkstemp(suffix=".mp4")
    os.close(tmp_fd)
    try:
        export_to_video(frames, tmp_path, fps=fps)
        with open(tmp_path, "rb") as f:
            video_bytes = f.read()
    finally:
        try:
            os.remove(tmp_path)
        except OSError:
            pass

    return {
        "video_base64": base64.b64encode(video_bytes).decode("ascii"),
        "seed": seed,
        "model": model_key,
        "num_frames": num_frames,
        "fps": fps,
        "steps": steps,
        "guidance_scale": guidance_scale,
        "width": width,
        "height": height,
    }


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        sys.stderr.write("[video-gen-sidecar] " + (fmt % args) + "\n")

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
                "model_loaded": _state["model_key"],
                "device": _state["device"],
            })
            return
        self._send_json(404, {"error": "not found"})

    def do_POST(self):
        _last_request_at["ts"] = time.time()
        if self.path != "/generate":
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
                result = _generate(payload)
                self._send_json(200, result)
            except Exception as exc:  # noqa: BLE001 - report every failure to the caller
                self._send_json(500, {"error": str(exc)})


def _idle_watchdog(max_idle_seconds: float):
    while True:
        time.sleep(15)
        if time.time() - _last_request_at["ts"] > max_idle_seconds:
            sys.stderr.write("[video-gen-sidecar] idle timeout reached, exiting\n")
            sys.exit(0)


DEFAULT_MODEL_KEY = "cogvideox-2b"
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
    sys.stderr.write(f"[video-gen-sidecar] listening on 127.0.0.1:{ARGS.port}\n")
    server.serve_forever()
