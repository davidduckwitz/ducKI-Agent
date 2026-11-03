#!/usr/bin/env python3
"""
Persistent local inference server for Kyutai's Pocket TTS (https://github.com/kyutai-labs/pocket-tts).

Pocket TTS is a ~100M-parameter model built for CPUs (real-time on 2 cores, ~200 ms to the first
audio chunk) with true incremental streaming. One model per language (german, english, french,
spanish, italian, portuguese, dutch); models load lazily per request language, the most recently
used ones stay in memory.

Same HTTP contract as chatterbox_server.py / qwen3_tts_server.py (/health, /voices, /synthesize,
/synthesize_stream, /model/load, /model/unload) so the Node provider + Settings controls are uniform.

Voices:
  * built-in catalog voices by name (e.g. "juergen" for German, "alba" for English)
  * your own reference clips voices/<id>.wav (shared with Chatterbox/Qwen3-TTS). Voice CLONING weights
    are gated on Hugging Face: accept the terms at https://huggingface.co/kyutai/pocket-tts and provide an HF token
    (the app passes the token stored under Settings > Agent > Zugangsdaten as HF_TOKEN). Without it only the built-in catalog voices work - requests for a cloned voice
    then fall back to the language's default catalog voice (reported as "cloningAvailable": false).

Setup (own venv, CPU-only torch is enough and small):
    python -m venv .venv-pocket && .venv-pocket/Scripts/activate
    pip install -r requirements-pocket-tts.txt
    python pocket_tts_server.py

Env vars:
    POCKET_TTS_HOST (default 127.0.0.1)      POCKET_TTS_PORT (default 8893)
    POCKET_TTS_LANGUAGE (default "german")   language used when a request doesn't specify one
    POCKET_TTS_DEVICE (default "cpu")        "cuda" works but is only ~2.6x faster than CPU
    POCKET_TTS_MAX_MODELS (default 2)        loaded language models kept in memory
    POCKET_TTS_MAX_TEXT_LEN (default 4000)
    POCKET_TTS_LAZY_LOAD ("1" = start HTTP first, load on demand)
    POCKET_TTS_SKIP_WARMUP ("1" skips the warmup pass)
"""

import gc
import io
import os
import sys
import threading
import time
import wave
from collections import OrderedDict
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path

from flask import Flask, Response, jsonify, request, send_file, stream_with_context

app = Flask(__name__)

DEFAULT_LANGUAGE = os.environ.get("POCKET_TTS_LANGUAGE", "german")
DEVICE = os.environ.get("POCKET_TTS_DEVICE", "cpu")
MAX_MODELS = max(1, int(os.environ.get("POCKET_TTS_MAX_MODELS", "2")))
MAX_TEXT_LEN = int(os.environ.get("POCKET_TTS_MAX_TEXT_LEN", "4000"))
VOICES_DIR = Path(__file__).parent / "voices"

STREAM_SAMPLE_RATE = 24000

LANGUAGE_BY_CODE = {
    "de": "german", "en": "english", "fr": "french", "es": "spanish",
    "it": "italian", "pt": "portuguese", "nl": "dutch",
}
LANGUAGES = set(LANGUAGE_BY_CODE.values())
DEFAULT_VOICE_BY_LANGUAGE = {
    "german": "juergen", "english": "alba", "french": "estelle", "spanish": "lola",
    "italian": "giovanni", "portuguese": "rafael", "dutch": "daan",
}

_models = OrderedDict()  # language -> TTSModel (LRU)
_voice_states = OrderedDict()  # (language, voice key) -> model state (LRU)
VOICE_STATE_CACHE_SIZE = 8
_lock = threading.RLock()  # TTSModel is not thread-safe: one generation at a time
_busy = False
_load_error = None
_metrics = {"requests": 0, "lastSynthesisMs": 0, "lastFirstChunkMs": None, "lastAudioSeconds": 0, "lastRealtimeFactor": None}


def log(message):
    print(f"[pocket_tts_server] {message}", flush=True)


def catalog_voices():
    from pocket_tts.utils.utils import _ORIGINS_OF_PREDEFINED_VOICES

    return list(_ORIGINS_OF_PREDEFINED_VOICES.keys())


def resolve_language(language):
    if not language:
        return DEFAULT_LANGUAGE
    normalized = language.strip().lower()
    code = normalized.split("-")[0]
    if code in LANGUAGE_BY_CODE:
        return LANGUAGE_BY_CODE[code]
    if normalized in LANGUAGES:
        return normalized
    raise ValueError(f"Unsupported language '{language}'. Supported: {', '.join(sorted(LANGUAGES))}")


def get_model(language):
    """Loads (or returns the cached) model for `language`; evicts the least recently used beyond MAX_MODELS."""
    global _load_error
    from pocket_tts import TTSModel

    with _lock:
        if language in _models:
            _models.move_to_end(language)
            return _models[language]
        log(f"Loading Pocket TTS model '{language}' on {DEVICE} ...")
        start = time.monotonic()
        try:
            model = TTSModel.load_model(language=language)
            if DEVICE != "cpu":
                model = model.to(DEVICE)
        except Exception as error:  # noqa: BLE001
            _load_error = str(error)
            raise
        _load_error = None
        _models[language] = model
        while len(_models) > MAX_MODELS:
            evicted, _ = _models.popitem(last=False)
            for key in [k for k in _voice_states if k[0] == evicted]:
                del _voice_states[key]
            log(f"Evicted model '{evicted}'")
        log(f"Model '{language}' loaded in {time.monotonic() - start:.1f}s (cloning={model.has_voice_cloning})")
        return model


def voice_state_for(model, language, voice_id):
    """Returns (state, effective_voice). Own clips need the gated cloning weights; otherwise falls back."""
    default_voice = DEFAULT_VOICE_BY_LANGUAGE[language]
    wanted = voice_id if voice_id and voice_id != "default" else default_voice

    wav = VOICES_DIR / f"{wanted}.wav"
    if wav.is_file() and wav.resolve().parent == VOICES_DIR.resolve():
        if model.has_voice_cloning:
            stat = wav.stat()
            key = (language, str(wav), stat.st_mtime_ns, stat.st_size)
            if key not in _voice_states:
                _voice_states[key] = model.get_state_for_audio_prompt(wav)
            _voice_states.move_to_end(key)
            while len(_voice_states) > VOICE_STATE_CACHE_SIZE:
                _voice_states.popitem(last=False)
            return _voice_states[key], wanted
        log(f"Voice cloning weights unavailable - using catalog voice '{default_voice}' instead of '{wanted}' "
            "(accept the terms at huggingface.co/kyutai/pocket-tts and set an HF token in Settings > Agent > Zugangsdaten)")
        wanted = default_voice

    if wanted not in catalog_voices():
        raise FileNotFoundError(f"Voice '{wanted}' not found (neither voices/{wanted}.wav nor a catalog voice).")
    key = (language, wanted)
    if key not in _voice_states:
        _voice_states[key] = model.get_state_for_audio_prompt(wanted)
    _voice_states.move_to_end(key)
    while len(_voice_states) > VOICE_STATE_CACHE_SIZE:
        _voice_states.popitem(last=False)
    return _voice_states[key], wanted


def to_pcm16(chunk):
    return (chunk.detach().cpu().numpy().clip(-1, 1) * 32767).astype("int16")


def resample_pcm16(pcm16, orig_sr, target_sr):
    if orig_sr == target_sr:
        return pcm16
    import numpy as np

    target_len = int(len(pcm16) / orig_sr * target_sr)
    idx = np.linspace(0, len(pcm16) - 1, target_len)
    return np.interp(idx, np.arange(len(pcm16)), pcm16.astype("float32")).astype("int16")


def warmup(language):
    if os.environ.get("POCKET_TTS_SKIP_WARMUP") == "1":
        return
    try:
        start = time.monotonic()
        model = get_model(language)
        state, _ = voice_state_for(model, language, None)
        for _ in model.generate_audio_stream(state, "Warmup."):
            pass
        log(f"Warmup done in {time.monotonic() - start:.1f}s - server ready")
    except Exception as error:  # noqa: BLE001 - warmup must never prevent serving
        log(f"Warmup failed: {error}")


def parse_request():
    payload = request.get_json(force=True) or {}
    text = (payload.get("text") or "").strip()
    if not text:
        raise ValueError("text is required")
    if len(text) > MAX_TEXT_LEN:
        raise ValueError(f"text exceeds the {MAX_TEXT_LEN}-character limit ({len(text)} chars) - split it into smaller chunks")
    voice_id = payload.get("voice")
    if voice_id and voice_id != "default" and ("/" in voice_id or "\\" in voice_id or ".." in voice_id):
        raise ValueError("Invalid voice id")
    return text, resolve_language(payload.get("language")), voice_id


def generate_chunks(text, language, voice_id, stop=None):
    """Yields (pcm16 ndarray, sample_rate) chunks as Pocket TTS produces them. Holds the generation lock."""
    global _busy
    with _lock:
        _busy = True
        started = time.monotonic()
        first_chunk_ms = None
        samples = 0
        try:
            model = get_model(language)
            state, effective = voice_state_for(model, language, voice_id)
            log(f"Voice requested={voice_id!r} -> using {effective!r}")
            sr = model.sample_rate
            for chunk in model.generate_audio_stream(state, text, stop=stop):
                if first_chunk_ms is None:
                    first_chunk_ms = round((time.monotonic() - started) * 1000)
                pcm = to_pcm16(chunk)
                samples += len(pcm)
                yield pcm, sr
        finally:
            _busy = False
            elapsed = time.monotonic() - started
            duration = samples / (model.sample_rate if "model" in locals() else STREAM_SAMPLE_RATE)
            _metrics.update(requests=_metrics["requests"] + 1, lastSynthesisMs=round(elapsed * 1000),
                            lastFirstChunkMs=first_chunk_ms, lastAudioSeconds=round(duration, 2),
                            lastRealtimeFactor=round(elapsed / duration, 2) if duration else None)
            log(f"Synthesis lang={language} chars={len(text)} first_chunk_ms={first_chunk_ms} "
                f"audio_s={duration:.2f} rtf={_metrics['lastRealtimeFactor']}")


def package_version():
    try:
        return version("pocket-tts")
    except PackageNotFoundError:
        return None


@app.route("/model/load", methods=["POST"])
def model_load():
    try:
        language = resolve_language(None)
        get_model(language)
        warmup(language)
        return health()
    except Exception as error:  # noqa: BLE001
        log(f"Model load failed: {error}")
        return jsonify({"error": str(error)}), 500


@app.route("/model/unload", methods=["POST"])
def model_unload():
    if not _lock.acquire(blocking=False):
        return jsonify({"error": "Model is busy; retry after the current operation"}), 409
    try:
        _models.clear()
        _voice_states.clear()
        gc.collect()
        try:
            import torch
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
        except Exception:  # noqa: BLE001
            pass
    finally:
        _lock.release()
    return health()


@app.route("/health", methods=["GET"])
def health():
    cloning = None
    if _models:
        cloning = all(m.has_voice_cloning for m in _models.values())
    return jsonify({"status": "ok", "modelLoaded": bool(_models), "loadedLanguages": list(_models.keys()),
                    "defaultLanguage": DEFAULT_LANGUAGE, "device": DEVICE, "busy": _busy,
                    "cloningAvailable": cloning, "packageVersion": package_version(),
                    "loadError": _load_error, "metrics": dict(_metrics)})


@app.route("/voices", methods=["GET"])
def voices():
    result = []
    for wav_path in sorted(VOICES_DIR.glob("*.wav")) if VOICES_DIR.is_dir() else []:
        result.append({"id": wav_path.stem, "name": f"{wav_path.stem} (eigene Aufnahme)"})
    try:
        for name in catalog_voices():
            result.append({"id": name, "name": name})
    except Exception as error:  # noqa: BLE001
        log(f"Catalog listing failed: {error}")
    return jsonify({"voices": result})


@app.route("/synthesize", methods=["POST"])
def synthesize():
    try:
        text, language, voice_id = parse_request()
    except (ValueError, FileNotFoundError) as err:
        return jsonify({"error": str(err)}), 400
    try:
        parts, sr = [], STREAM_SAMPLE_RATE
        for pcm, sr in generate_chunks(text, language, voice_id):
            parts.append(pcm)
    except FileNotFoundError as err:
        return jsonify({"error": str(err)}), 400
    except Exception as err:  # noqa: BLE001 - any model failure must come back as clean JSON
        log(f"Synthesis failed: {err}")
        return jsonify({"error": f"Synthesis failed: {err}"}), 500
    import numpy as np

    pcm16 = np.concatenate(parts) if parts else np.zeros(0, dtype="int16")
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
    try:
        text, language, voice_id = parse_request()
    except (ValueError, FileNotFoundError) as err:
        return jsonify({"error": str(err)}), 400

    stop = threading.Event()
    gen = generate_chunks(text, language, voice_id, stop)
    # Probe the first chunk so setup errors (unknown voice, model load) still return a clean JSON error.
    try:
        first = next(gen)
    except StopIteration:
        return Response(b"", mimetype="application/octet-stream")
    except FileNotFoundError as err:
        return jsonify({"error": str(err)}), 400
    except Exception as err:  # noqa: BLE001
        log(f"Streaming synthesis failed: {err}")
        return jsonify({"error": f"Synthesis failed: {err}"}), 500

    def body():
        try:
            yield resample_pcm16(first[0], first[1], STREAM_SAMPLE_RATE).tobytes()
            for pcm, sr in gen:
                yield resample_pcm16(pcm, sr, STREAM_SAMPLE_RATE).tobytes()
        except Exception as err:  # noqa: BLE001 - the 200 header is already sent; log and end the stream
            log(f"Streaming synthesis failed mid-stream: {err}")
        finally:
            stop.set()  # client went away (or finished): stop generating
            gen.close()

    return Response(stream_with_context(body()), mimetype="application/octet-stream")


def main():
    host = os.environ.get("POCKET_TTS_HOST", "127.0.0.1")
    port = int(os.environ.get("POCKET_TTS_PORT", "8893"))
    if os.environ.get("POCKET_TTS_LAZY_LOAD") != "1":
        get_model(resolve_language(None))
        warmup(resolve_language(None))
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
