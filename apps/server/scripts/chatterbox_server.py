#!/usr/bin/env python3
"""
Persistent local inference server for Chatterbox TTS's multilingual model
(https://github.com/resemble-ai/chatterbox, ChatterboxMultilingualTTS - 23 languages including
German, not the English-only base model).

Loads the model once and serves it over HTTP so Node's chatterbox-text-to-speech-provider.ts
never pays a per-request model-load cost - see apps/server/scripts/README.md.

Setup:
    python -m venv .venv
    .venv/Scripts/activate   (Windows)  or  source .venv/bin/activate  (Linux/Mac)
    pip install -r requirements-chatterbox.txt
    python chatterbox_server.py

Env vars:
    CHATTERBOX_HOST (default 127.0.0.1)
    CHATTERBOX_PORT (default 8890)
    CHATTERBOX_MODEL (must be "v3"; default "v3")
    CHATTERBOX_DEVICE (default "cuda" if available, else "cpu")
    CHATTERBOX_LANGUAGE (default "en") - language_id used when a request doesn't specify one
    CHATTERBOX_MAX_TEXT_LEN (default 20000) - cheap character pre-filter before the real,
        token-based length check (see validate_text_length()) - not the actual safety limit
    CHATTERBOX_SKIP_WARMUP (default unset) - set to "1" to skip the startup warmup pass
"""

import io
import gc
import inspect
import json
from importlib.metadata import version, distribution, PackageNotFoundError
import os
import sys
import threading
import time
import wave
from collections import OrderedDict
from copy import copy
from pathlib import Path

from flask import g, Flask, Response, jsonify, request, send_file, stream_with_context

app = Flask(__name__)

_model = None
_device = os.environ.get("CHATTERBOX_DEVICE")
_model_lock = threading.RLock()
_model_variant = None
_model_busy = False
_default_conditionals = None
_voice_conditionals = OrderedDict()
VOICE_CACHE_SIZE = max(0, int(os.environ.get("CHATTERBOX_VOICE_CACHE_SIZE", "2")))
_metrics = {"requests": 0, "voiceCacheHits": 0, "lastQueueMs": 0, "lastSynthesisMs": 0, "lastAudioSeconds": 0, "lastRealtimeFactor": None}

# The T3 model's positional embeddings only support hp.max_text_tokens text tokens (2048 as
# shipped) - exceeding it does NOT raise a clean Python exception, it crashes CUDA with a
# device-side assertion ("Assertion `srcIndex < srcSelectDimSize` failed"), which can leave the
# CUDA context broken for the rest of the process, not just fail the one request. Token density
# varies a lot by language (measured ~1.4 chars/token for German; CJK languages are typically
# far denser per character), so a fixed CHARACTER limit can never safely stand in for this across
# all of SUPPORTED_LANGUAGES - the actual tokenizer output has to be checked. See
# validate_text_length() below, which does the real check; MAX_TEXT_LEN here is just a cheap
# pre-filter so a pathologically huge request doesn't spend time tokenizing before being
# rejected, not the safety mechanism itself.
MAX_TEXT_LEN = int(os.environ.get("CHATTERBOX_MAX_TEXT_LEN", "20000"))
# Headroom under hp.max_text_tokens for the start/stop/special tokens generate() adds internally
# around the raw tokenized text (see chatterbox/models/t3/t3.py's start_text_token/
# stop_text_token handling) - text_to_tokens() alone doesn't include those.
TEXT_TOKEN_SAFETY_MARGIN = 16

# Chatterbox has no named voice presets ("male"/"female"/etc.) - it clones whatever speaker is
# in a short reference clip (zero-shot voice cloning via `audio_prompt_path`). Drop .wav files
# here (5-20s of clean single-speaker speech) and their filename (without extension) becomes
# the voice id shown in the app's Voice tab / Settings picker - see README.md.
VOICES_DIR = Path(__file__).parent / "voices"

# Fixed contract for /synthesize_stream: the Node provider's streamSampleRate is hardcoded to
# this value, so any model sample rate is resampled to match instead of leaving that mismatch
# for the client's Web Audio playback to (silently, as wrong pitch/speed) get wrong.
STREAM_SAMPLE_RATE = 24000
STREAM_CHUNK_SAMPLES = 4096


def log(message):
    print(f"[chatterbox_server] {message}", flush=True)


def resolve_voice_path(voice_id):
    """Returns the reference-audio path for a voice id, or None for the built-in default voice."""
    if not voice_id or voice_id == "default":
        return None
    candidate = VOICES_DIR / f"{voice_id}.wav"
    if candidate.resolve().parent != VOICES_DIR.resolve():
        raise ValueError("Invalid voice id")
    if not candidate.is_file():
        raise FileNotFoundError(
            f"Voice '{voice_id}' not found ({candidate}). Drop a .wav reference clip named "
            f"'{voice_id}.wav' into {VOICES_DIR} or use 'default'."
        )
    return str(candidate)


def resample_pcm16(pcm16, orig_sr, target_sr):
    if orig_sr == target_sr:
        return pcm16
    import numpy as np

    duration = len(pcm16) / orig_sr
    target_len = int(duration * target_sr)
    orig_idx = np.arange(len(pcm16))
    target_idx = np.linspace(0, len(pcm16) - 1, target_len)
    resampled = np.interp(target_idx, orig_idx, pcm16.astype("float32"))
    return resampled.astype("int16")


DEFAULT_LANGUAGE = os.environ.get("CHATTERBOX_LANGUAGE", "en")


def load_model():
    """Loads the model eagerly (called once at process startup, not lazily on first request) -
    a broken install then fails loudly in the terminal immediately instead of surfacing as a
    confusing timeout on the user's first real request.

    Uses the multilingual model (ChatterboxMultilingualTTS) rather than the English-only base
    model - the base model mishandles non-English text (garbled prosody/pronunciation) since it
    was never trained on it, whereas the multilingual model has explicit per-language support
    (see SUPPORTED_LANGUAGES) including German. It still covers English fine, so there is no
    reason to keep two code paths for one language vs. the other 22."""
    global _model, _device, _default_conditionals, _model_variant
    import torch
    from chatterbox.mtl_tts import ChatterboxMultilingualTTS

    if not _device:
        _device = "cuda" if torch.cuda.is_available() else "cpu"
    log(f"Loading Chatterbox multilingual model on device={_device} ...")
    start = time.monotonic()
    if os.environ.get("CHATTERBOX_MODEL", "v3") != "v3":
        raise ValueError("This server requires CHATTERBOX_MODEL=v3. Remove any legacy v2/auto override.")
    if "t3_model" not in inspect.signature(ChatterboxMultilingualTTS.from_pretrained).parameters:
        raise RuntimeError("This Chatterbox installation does not support V3. Install requirements-chatterbox.txt with the server's Python interpreter.")
    model = ChatterboxMultilingualTTS.from_pretrained(device=_device, t3_model="v3")
    _model = model
    _model_variant = "v3"
    _default_conditionals = copy(_model.conds)
    _voice_conditionals.clear()
    log(f"Model loaded in {time.monotonic() - start:.1f}s")


def warmup_model():
    """Pays the one-time JIT/kernel-autotune/allocator warmup cost here instead of on the first
    real user request, which would otherwise be noticeably slower than every request after it."""
    if os.environ.get("CHATTERBOX_SKIP_WARMUP") == "1":
        return
    log("Warming up (first inference pass is slower than steady-state) ...")
    start = time.monotonic()
    import torch
    with _model_lock, torch.inference_mode():
        _model.generate("Warmup.", language_id=DEFAULT_LANGUAGE, exaggeration=0.5)
    log(f"Warmup done in {time.monotonic() - start:.1f}s - server ready")


def resolve_language(language_id):
    from chatterbox.mtl_tts import SUPPORTED_LANGUAGES

    if not language_id:
        return DEFAULT_LANGUAGE
    normalized = language_id.strip().lower()
    # The Node provider already strips a BCP-47 region ("de-DE" -> "de") before sending, but
    # normalize here too as defense in depth for any other caller of this API.
    normalized = normalized.split("-")[0]
    if normalized not in SUPPORTED_LANGUAGES:
        raise ValueError(
            f"Unsupported language '{language_id}'. Supported: {', '.join(sorted(SUPPORTED_LANGUAGES))}"
        )
    return normalized


def synthesize_pcm16(text, language_id, exaggeration, audio_prompt_path):
    """Serializes access to the model - Chatterbox's generate() is not documented as
    thread-safe for concurrent calls, and running two generations at once on the same weights
    risks corrupted output or a crash rather than just being slow. Concurrent requests queue
    here instead; the Node-side WS handler already only ever has one in flight per connection,
    so this only matters if multiple browser tabs/sessions hit the server at the same time."""
    import torch
    queued_at = time.monotonic()
    with _model_lock, torch.inference_mode():
        started = time.monotonic()
        if audio_prompt_path:
            # Re-encode only when the file changes. Bounded to avoid filling GPU memory.
            stat = Path(audio_prompt_path).stat()
            key = (audio_prompt_path, stat.st_mtime_ns, stat.st_size)
            cached = _voice_conditionals.get(key)
            if cached is None:
                _model.prepare_conditionals(audio_prompt_path, exaggeration=exaggeration)
                if VOICE_CACHE_SIZE:
                    _voice_conditionals[key] = copy(_model.conds)
                    while len(_voice_conditionals) > VOICE_CACHE_SIZE:
                        _voice_conditionals.popitem(last=False)
            else:
                _model.conds = copy(cached)
                _voice_conditionals.move_to_end(key)
                _metrics["voiceCacheHits"] += 1
        else:
            # generate() otherwise keeps the last cloned speaker when returning to default.
            _model.conds = copy(_default_conditionals)
        wav_tensor = _model.generate(text, language_id=language_id, exaggeration=exaggeration)
        pcm16 = (wav_tensor.squeeze().cpu().numpy().clip(-1, 1) * 32767).astype("int16")
        elapsed = time.monotonic() - started
        duration = len(pcm16) / _model.sr
        _metrics.update(requests=_metrics["requests"] + 1,
                        lastQueueMs=round((started - queued_at) * 1000),
                        lastSynthesisMs=round(elapsed * 1000), lastAudioSeconds=round(duration, 2),
                        lastRealtimeFactor=round(elapsed / duration, 2) if duration else None)
        log(f"Synthesis chars={len(text)} queue_ms={_metrics['lastQueueMs']} generation_ms={_metrics['lastSynthesisMs']} audio_s={duration:.2f} rtf={_metrics['lastRealtimeFactor']}")
    return pcm16


def validate_text_length(text, language_id):
    """Raises ValueError if `text` would overflow the model's real text-token budget for
    `language_id`. This is the actual safety mechanism (see MAX_TEXT_LEN's comment above) -
    tokenizes with the same tokenizer/language generate() will use, so the count is exact rather
    than an estimate."""
    max_tokens = _model.t3.hp.max_text_tokens - TEXT_TOKEN_SAFETY_MARGIN
    token_count = _model.tokenizer.text_to_tokens(text, language_id=language_id).shape[1]
    if token_count > max_tokens:
        raise ValueError(
            f"text is too long for the model ({token_count} tokens for language '{language_id}', "
            f"limit {max_tokens}) - split it into smaller chunks"
        )


def parse_request():
    """Shared request parsing/validation for both synthesis endpoints. Returns
    (text, language_id, exaggeration, audio_prompt_path) or raises ValueError/FileNotFoundError
    with a message suitable for a 400 response."""
    payload = request.get_json(force=True) or {}
    text = (payload.get("text") or "").strip()
    if not text:
        raise ValueError("text is required")
    if len(text) > MAX_TEXT_LEN:
        raise ValueError(f"text exceeds the {MAX_TEXT_LEN}-character pre-filter ({len(text)} chars) - split it into smaller chunks")

    language_id = resolve_language(payload.get("language"))
    validate_text_length(text, language_id)
    exaggeration = max(0.0, min(1.0, float(payload.get("emotion_exaggeration", 0.5))))
    audio_prompt_path = resolve_voice_path(payload.get("voice"))
    return text, language_id, exaggeration, audio_prompt_path


def package_version():
    try:
        return version("chatterbox-tts")
    except PackageNotFoundError:
        return None


def package_revision():
    try:
        direct_url = distribution("chatterbox-tts").read_text("direct_url.json")
        return json.loads(direct_url or "{}").get("vcs_info", {}).get("commit_id")
    except (PackageNotFoundError, ValueError):
        return None


# Hold the lock from token validation through WAV serialization; unload cannot race either.
@app.before_request
def lock_model_request():
    global _model_busy
    if request.path not in ("/synthesize", "/synthesize_stream", "/model/load", "/model/unload"):
        return None
    if not _model_lock.acquire(blocking=False):
        return jsonify({"error": "Model is busy; retry after the current operation"}), 409
    g.model_locked = True
    _model_busy = True
    if request.path.startswith("/synthesize") and _model is None:
        return jsonify({"error": "Model is unloaded. Load it in Settings first."}), 409
    return None


@app.teardown_request
def unlock_model_request(error):
    global _model_busy
    if getattr(g, "model_locked", False):
        g.model_locked = False
        _model_busy = False
        _model_lock.release()


@app.route("/model/load", methods=["POST"])
def model_load():
    try:
        if _model is None:
            load_model()
            warmup_model()
        return health()
    except Exception as error:
        return jsonify({"error": str(error)}), 500


@app.route("/model/unload", methods=["POST"])
def model_unload():
    global _model, _default_conditionals
    _model = None
    _default_conditionals = None
    _voice_conditionals.clear()
    gc.collect()
    import torch
    if torch.cuda.is_available():
        torch.cuda.empty_cache()
    return health()


@app.route("/health", methods=["GET"])
def health():
    return jsonify({"status": "ok", "modelLoaded": _model is not None, "device": _device,
                    "busy": _model_busy, "modelVariant": _model_variant, "requiredModelVariant": "v3", "packageVersion": package_version(), "packageRevision": package_revision(), "voiceCacheEntries": len(_voice_conditionals),
                    "metrics": dict(_metrics)})


@app.route("/voices", methods=["GET"])
def voices():
    result = [{"id": "default", "name": "Chatterbox Standard"}]
    if VOICES_DIR.is_dir():
        for wav_path in sorted(VOICES_DIR.glob("*.wav")):
            result.append({"id": wav_path.stem, "name": wav_path.stem})
    return jsonify({"voices": result})


@app.route("/synthesize", methods=["POST"])
def synthesize():
    try:
        text, language_id, exaggeration, audio_prompt_path = parse_request()
    except (ValueError, FileNotFoundError) as err:
        return jsonify({"error": str(err)}), 400

    try:
        pcm16 = synthesize_pcm16(text, language_id, exaggeration, audio_prompt_path)
    except Exception as err:  # noqa: BLE001 - deliberately broad: any model failure must come
        # back as a clean JSON error over HTTP, never an unhandled 500/hang the caller can't
        # parse (e.g. CUDA OOM, a corrupt reference WAV).
        log(f"Synthesis failed: {err}")
        return jsonify({"error": f"Synthesis failed: {err}"}), 500

    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as wav_file:
        wav_file.setnchannels(1)
        wav_file.setsampwidth(2)
        wav_file.setframerate(_model.sr)
        wav_file.writeframes(pcm16.tobytes())
    buffer.seek(0)

    return send_file(buffer, mimetype="audio/wav")


@app.route("/synthesize_stream", methods=["POST"])
def synthesize_stream():
    try:
        text, language_id, exaggeration, audio_prompt_path = parse_request()
    except (ValueError, FileNotFoundError) as err:
        return jsonify({"error": str(err)}), 400

    try:
        pcm16 = synthesize_pcm16(text, language_id, exaggeration, audio_prompt_path)
        pcm16 = resample_pcm16(pcm16, _model.sr, STREAM_SAMPLE_RATE)
    except Exception as err:  # noqa: BLE001 - see synthesize()'s comment
        log(f"Streaming synthesis failed: {err}")
        return jsonify({"error": f"Synthesis failed: {err}"}), 500

    # Chatterbox has no token-level streaming synthesis (see chatterbox-text-to-speech-
    # provider.ts's comment) - this chunks the already-finished PCM so the client can start
    # decoding/playing before the full transfer completes, rather than a true incremental
    # generation stream.
    def generate_chunks():
        raw = pcm16.tobytes()
        chunk_bytes = STREAM_CHUNK_SAMPLES * 2  # 16-bit samples
        for i in range(0, len(raw), chunk_bytes):
            yield raw[i : i + chunk_bytes]

    return Response(stream_with_context(generate_chunks()), mimetype="application/octet-stream")


def main():
    host = os.environ.get("CHATTERBOX_HOST", "127.0.0.1")
    port = int(os.environ.get("CHATTERBOX_PORT", "8890"))

    if os.environ.get("CHATTERBOX_LAZY_LOAD") != "1":
        load_model()
        warmup_model()

    try:
        from waitress import serve

        log(f"Serving with waitress on http://{host}:{port} (production-grade, multi-threaded)")
        # threads=4: generate() itself is still serialized by _model_lock, but this lets
        # /health and /voices answer instantly even while a synthesis request is in flight,
        # instead of queuing behind it like Flask's single-threaded dev server would.
        serve(app, host=host, port=port, threads=4)
    except ImportError:
        log(
            "waitress not installed (pip install waitress) - falling back to Flask's development "
            "server. That's fine for local single-user use, but it is single-threaded: /health "
            "will block while a synthesis request is in flight."
        )
        app.run(host=host, port=port)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(0)
