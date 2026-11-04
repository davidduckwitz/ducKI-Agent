#!/usr/bin/env python3
"""
Persistent local inference server for Qwen3-TTS (https://github.com/QwenLM/Qwen3-TTS, Apache-2.0).

Mirrors chatterbox_server.py's HTTP contract (/health, /voices, /synthesize, /synthesize_stream,
/model/load, /model/unload) so Node's qwen3-tts-text-to-speech-provider.ts and the runtime
controls in Settings > Sprache work the same way for both engines.

Two model families are supported, auto-detected from QWEN_TTS_MODEL:
  * "...-Base"        -> zero-shot voice cloning from a reference clip in voices/<id>.wav
                         (optional voices/<id>.txt = transcript of the clip, improves quality;
                         without it the speaker embedding alone is used)
  * "...-CustomVoice" -> built-in speakers (Ryan, Aiden, Vivian, ...); the 1.7B variant also
                         honors a free-text style instruction ("instruct")

Setup (separate venv - qwen-tts pins its own transformers version):
    python -m venv .venv-qwen
    .venv-qwen/Scripts/activate   (Windows)  or  source .venv-qwen/bin/activate
    pip install -r requirements-qwen3-tts.txt
    python qwen3_tts_server.py

Env vars:
    QWEN_TTS_HOST (default 127.0.0.1)
    QWEN_TTS_PORT (default 8892)
    QWEN_TTS_MODEL (default Qwen/Qwen3-TTS-12Hz-0.6B-Base) - HF id or local directory
    QWEN_TTS_DEVICE (default "cuda:0" if available, else "cpu")
    QWEN_TTS_DTYPE (default bfloat16 on CUDA, float32 on CPU)
    QWEN_TTS_ATTN (default: flash_attention_2 if flash-attn is importable, else sdpa)
    QWEN_TTS_LANGUAGE (default "Auto") - language used when a request doesn't specify one
    QWEN_TTS_DEFAULT_SPEAKER (default "Ryan") - CustomVoice models, when no voice is requested
    QWEN_TTS_MAX_TEXT_LEN (default 2000)
    QWEN_TTS_LAZY_LOAD (set to "1" by the Node runtime: start HTTP first, load model on demand)
    QWEN_TTS_SKIP_WARMUP (set to "1" to skip the startup warmup pass)
"""

import io
import gc
import json
import os
import sys
import threading
import time
import wave
from collections import OrderedDict
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path

from flask import Flask, Response, g, jsonify, request, send_file, stream_with_context

app = Flask(__name__)

MODEL_ID = os.environ.get("QWEN_TTS_MODEL", "Qwen/Qwen3-TTS-12Hz-0.6B-Base")
DEFAULT_LANGUAGE = os.environ.get("QWEN_TTS_LANGUAGE", "Auto")
DEFAULT_SPEAKER = os.environ.get("QWEN_TTS_DEFAULT_SPEAKER", "Ryan")
MAX_TEXT_LEN = int(os.environ.get("QWEN_TTS_MAX_TEXT_LEN", "2000"))

_model = None
_device = os.environ.get("QWEN_TTS_DEVICE")
_attn = None
_model_lock = threading.RLock()
_model_busy = False
_clone_prompts = OrderedDict()
CLONE_PROMPT_CACHE_SIZE = 4
_metrics = {"requests": 0, "lastQueueMs": 0, "lastSynthesisMs": 0, "lastAudioSeconds": 0, "lastRealtimeFactor": None}

# Same voices/ folder as Chatterbox - existing reference clips work for both engines.
VOICES_DIR = Path(os.environ.get("DUCKI_VOICES_DIR") or Path(__file__).parent / "voices")

# Fixed contract for /synthesize_stream: the Node provider's streamSampleRate is hardcoded to
# this value, so any model sample rate is resampled to match.
STREAM_SAMPLE_RATE = 24000
STREAM_CHUNK_SAMPLES = 4096

LANGUAGE_NAMES = {
    "zh": "Chinese", "en": "English", "ja": "Japanese", "ko": "Korean", "de": "German",
    "fr": "French", "ru": "Russian", "pt": "Portuguese", "es": "Spanish", "it": "Italian",
}


def log(message):
    print(f"[qwen3_tts_server] {message}", flush=True)


def is_clone_model():
    return "base" in MODEL_ID.lower().split("/")[-1]


def supports_instruct():
    name = MODEL_ID.lower().split("/")[-1]
    return "customvoice" in name and "1.7b" in name


def resolve_language(language):
    if not language:
        return DEFAULT_LANGUAGE
    normalized = language.strip()
    code = normalized.split("-")[0].lower()
    if code in LANGUAGE_NAMES:
        return LANGUAGE_NAMES[code]
    if normalized.capitalize() in LANGUAGE_NAMES.values() or normalized.lower() == "auto":
        return normalized.capitalize()
    raise ValueError(f"Unsupported language '{language}'. Supported: {', '.join(LANGUAGE_NAMES.values())}")


def list_voice_files():
    return sorted(VOICES_DIR.glob("*.wav")) if VOICES_DIR.is_dir() else []


def resolve_reference(voice_id):
    """Returns (wav_path, transcript_or_None) for clone models. 'default'/empty = first clip."""
    if not voice_id or voice_id == "default":
        files = list_voice_files()
        if not files:
            raise FileNotFoundError(
                f"Qwen3-TTS Base clont eine Stimme aus einer Referenzaufnahme, aber {VOICES_DIR} enthaelt "
                "keine .wav-Datei. Lege dort eine 5-20s lange, saubere Sprachaufnahme ab "
                "(optional <name>.txt mit dem gesprochenen Text) oder nutze ein CustomVoice-Modell."
            )
        candidate = files[0]
    else:
        candidate = VOICES_DIR / f"{voice_id}.wav"
        if candidate.resolve().parent != VOICES_DIR.resolve():
            raise ValueError("Invalid voice id")
        if not candidate.is_file():
            raise FileNotFoundError(f"Voice '{voice_id}' not found ({candidate}).")
    transcript_path = candidate.with_suffix(".txt")
    transcript = transcript_path.read_text(encoding="utf-8").strip() if transcript_path.is_file() else None
    return str(candidate), transcript or None


def resample_pcm16(pcm16, orig_sr, target_sr):
    if orig_sr == target_sr:
        return pcm16
    import numpy as np

    duration = len(pcm16) / orig_sr
    target_len = int(duration * target_sr)
    target_idx = np.linspace(0, len(pcm16) - 1, target_len)
    return np.interp(target_idx, np.arange(len(pcm16)), pcm16.astype("float32")).astype("int16")


def load_model():
    global _model, _device, _attn
    import torch
    from qwen_tts import Qwen3TTSModel

    cuda = torch.cuda.is_available()
    if not _device:
        _device = "cuda:0" if cuda else "cpu"
    on_cuda = _device.startswith("cuda")
    dtype_name = os.environ.get("QWEN_TTS_DTYPE") or ("bfloat16" if on_cuda else "float32")
    dtype = getattr(torch, dtype_name)

    _attn = os.environ.get("QWEN_TTS_ATTN")
    if not _attn:
        try:
            import flash_attn  # noqa: F401
            _attn = "flash_attention_2" if on_cuda and dtype in (torch.float16, torch.bfloat16) else "sdpa"
        except ImportError:
            _attn = "sdpa"

    log(f"Loading {MODEL_ID} on device={_device} dtype={dtype_name} attn={_attn} ...")
    start = time.monotonic()
    _model = Qwen3TTSModel.from_pretrained(MODEL_ID, device_map=_device, dtype=dtype, attn_implementation=_attn)
    _clone_prompts.clear()
    log(f"Model loaded in {time.monotonic() - start:.1f}s")


def warmup_model():
    if os.environ.get("QWEN_TTS_SKIP_WARMUP") == "1":
        return
    try:
        log("Warming up ...")
        start = time.monotonic()
        generate_pcm16("Warmup.", "English", None, None)
        log(f"Warmup done in {time.monotonic() - start:.1f}s - server ready")
    except FileNotFoundError:
        log("Warmup skipped (no reference voice available yet)")
    except Exception as error:  # noqa: BLE001 - warmup must never prevent serving
        log(f"Warmup failed: {error}")


def clone_prompt_for(wav_path, transcript):
    stat = Path(wav_path).stat()
    key = (wav_path, stat.st_mtime_ns, stat.st_size, transcript)
    cached = _clone_prompts.get(key)
    if cached is not None:
        _clone_prompts.move_to_end(key)
        return cached
    prompt = _model.create_voice_clone_prompt(
        ref_audio=wav_path, ref_text=transcript, x_vector_only_mode=transcript is None
    )
    _clone_prompts[key] = prompt
    while len(_clone_prompts) > CLONE_PROMPT_CACHE_SIZE:
        _clone_prompts.popitem(last=False)
    return prompt


def generate_pcm16(text, language, voice_id, instruct):
    """Returns (pcm16 int16 ndarray, sample_rate). Serialized on the model lock."""
    import numpy as np
    import torch

    queued_at = time.monotonic()
    with _model_lock, torch.inference_mode():
        started = time.monotonic()
        if is_clone_model():
            wav_path, transcript = resolve_reference(voice_id)
            prompt = clone_prompt_for(wav_path, transcript)
            wavs, sr = _model.generate_voice_clone(text=text, language=language, voice_clone_prompt=prompt)
        else:
            speaker = voice_id if voice_id and voice_id != "default" else DEFAULT_SPEAKER
            kwargs = {"text": text, "language": language, "speaker": speaker}
            if instruct and supports_instruct():
                kwargs["instruct"] = instruct
            wavs, sr = _model.generate_custom_voice(**kwargs)
        wav = np.asarray(wavs[0], dtype="float32").squeeze()
        pcm16 = (wav.clip(-1, 1) * 32767).astype("int16")
        elapsed = time.monotonic() - started
        duration = len(pcm16) / sr
        _metrics.update(requests=_metrics["requests"] + 1,
                        lastQueueMs=round((started - queued_at) * 1000),
                        lastSynthesisMs=round(elapsed * 1000), lastAudioSeconds=round(duration, 2),
                        lastRealtimeFactor=round(elapsed / duration, 2) if duration else None)
        log(f"Synthesis chars={len(text)} generation_ms={_metrics['lastSynthesisMs']} audio_s={duration:.2f} rtf={_metrics['lastRealtimeFactor']}")
    return pcm16, sr


def parse_request():
    payload = request.get_json(force=True) or {}
    text = (payload.get("text") or "").strip()
    if not text:
        raise ValueError("text is required")
    if len(text) > MAX_TEXT_LEN:
        raise ValueError(f"text exceeds the {MAX_TEXT_LEN}-character limit ({len(text)} chars) - split it into smaller chunks")
    language = resolve_language(payload.get("language"))
    voice_id = payload.get("voice")
    if voice_id and voice_id != "default" and ("/" in voice_id or "\\" in voice_id or ".." in voice_id):
        raise ValueError("Invalid voice id")
    instruct = (payload.get("instruct") or "").strip() or None
    return text, language, voice_id, instruct


def package_version():
    try:
        return version("qwen-tts")
    except PackageNotFoundError:
        return None


# Hold the lock across the whole request so unload cannot race a running synthesis.
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
    except Exception as error:  # noqa: BLE001
        log(f"Model load failed: {error}")
        return jsonify({"error": str(error)}), 500


@app.route("/model/unload", methods=["POST"])
def model_unload():
    global _model
    _model = None
    _clone_prompts.clear()
    gc.collect()
    import torch
    if torch.cuda.is_available():
        torch.cuda.empty_cache()
    return health()


@app.route("/health", methods=["GET"])
def health():
    vram = None
    try:
        import torch
        if torch.cuda.is_available() and _model is not None:
            vram = round(torch.cuda.memory_allocated() / 1024**3, 2)
    except Exception:  # noqa: BLE001
        pass
    return jsonify({"status": "ok", "modelLoaded": _model is not None, "device": _device, "busy": _model_busy,
                    "model": MODEL_ID, "mode": "clone" if is_clone_model() else "speaker",
                    "supportsInstruct": supports_instruct(), "attention": _attn,
                    "packageVersion": package_version(), "vramAllocatedGb": vram,
                    "cloneCacheEntries": len(_clone_prompts), "metrics": dict(_metrics)})


@app.route("/voices", methods=["GET"])
def voices():
    if is_clone_model():
        result = [{"id": p.stem, "name": p.stem} for p in list_voice_files()]
        if not result:
            result = [{"id": "default", "name": "Keine Referenz-.wav in voices/"}]
        return jsonify({"voices": result})
    names = []
    try:
        if _model is not None:
            names = list(_model.get_supported_speakers())
    except Exception:  # noqa: BLE001
        pass
    if not names:
        names = ["Ryan", "Aiden", "Vivian", "Serena", "Uncle_Fu", "Dylan", "Eric", "Ono_Anna", "Sohee"]
    return jsonify({"voices": [{"id": n, "name": n} for n in names]})


def synthesize_or_error(target_sr=None):
    try:
        text, language, voice_id, instruct = parse_request()
    except (ValueError, FileNotFoundError) as err:
        return None, (jsonify({"error": str(err)}), 400)
    try:
        pcm16, sr = generate_pcm16(text, language, voice_id, instruct)
    except FileNotFoundError as err:
        return None, (jsonify({"error": str(err)}), 400)
    except Exception as err:  # noqa: BLE001 - any model failure (e.g. CUDA OOM) must come back as clean JSON
        log(f"Synthesis failed: {err}")
        return None, (jsonify({"error": f"Synthesis failed: {err}"}), 500)
    if target_sr:
        pcm16 = resample_pcm16(pcm16, sr, target_sr)
        sr = target_sr
    return (pcm16, sr), None


@app.route("/synthesize", methods=["POST"])
def synthesize():
    result, error = synthesize_or_error()
    if error:
        return error
    pcm16, sr = result
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as wav_file:
        wav_file.setnchannels(1)
        wav_file.setsampwidth(2)
        wav_file.setframerate(sr)
        wav_file.writeframes(pcm16.tobytes())
    buffer.seek(0)
    return send_file(buffer, mimetype="audio/wav")


@app.route("/synthesize_stream", methods=["POST"])
def synthesize_stream():
    result, error = synthesize_or_error(STREAM_SAMPLE_RATE)
    if error:
        return error
    pcm16, _ = result

    # qwen-tts exposes no documented incremental-generation API yet, so (like Chatterbox) this
    # chunks the finished PCM for progressive transfer. Latency stays per-sentence on the client.
    def generate_chunks():
        raw = pcm16.tobytes()
        chunk_bytes = STREAM_CHUNK_SAMPLES * 2
        for i in range(0, len(raw), chunk_bytes):
            yield raw[i : i + chunk_bytes]

    return Response(stream_with_context(generate_chunks()), mimetype="application/octet-stream")


def main():
    host = os.environ.get("QWEN_TTS_HOST", "127.0.0.1")
    port = int(os.environ.get("QWEN_TTS_PORT", "8892"))

    if os.environ.get("QWEN_TTS_LAZY_LOAD") != "1":
        load_model()
        warmup_model()

    try:
        from waitress import serve

        log(f"Serving with waitress on http://{host}:{port}")
        serve(app, host=host, port=port, threads=4)
    except ImportError:
        log("waitress not installed - falling back to Flask's development server")
        app.run(host=host, port=port)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(0)
