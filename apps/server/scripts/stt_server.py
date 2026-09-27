#!/usr/bin/env python3
"""
Persistent local speech-to-text server (faster-whisper / CTranslate2).

Keeps the Whisper model loaded between requests, so a voice command only pays for inference -
not for a process start + model load like the nodejs-whisper (whisper-cli) path does. Managed by
apps/server/src/lib/stt-runtime.ts (Settings > Sprache > "STT-Server starten/stoppen").

Setup (shares the Chatterbox venv - torch's CUDA DLLs are reused for CTranslate2 on Windows):
    pip install -r requirements-stt.txt

Env vars:
    STT_HOST (default 127.0.0.1)
    STT_PORT (default 8891)
    STT_MODEL (default "large-v3-turbo" on CUDA, "base" on CPU) - any faster-whisper model name
    STT_DEVICE ("auto" | "cuda" | "cpu", default "auto") - auto uses CUDA when a GPU is usable
    STT_COMPUTE_TYPE (default "float16" on CUDA, "int8" on CPU)
    STT_CPU_THREADS (default: half the logical cores, min 4)
    STT_BEAM_SIZE (default 1 - greedy; fastest, fine for short commands)
    STT_LAZY_LOAD ("1" = don't load the model until /model/load or the first request)
"""

import io
import gc
import os
import sys
import threading
import time
from pathlib import Path

from flask import Flask, jsonify, request

app = Flask(__name__)

_model = None
_model_name = None
_device = None
_compute_type = None
_load_error = None
_busy = False
_lock = threading.Lock()
_metrics = {"lastAudioSeconds": None, "lastTranscribeMs": None, "lastRealtimeFactor": None, "requests": 0}


def log(message):
    print(f"[stt] {message}", flush=True)


def add_cuda_dll_dirs():
    """On Windows CTranslate2 needs cuBLAS/cuDNN DLLs. torch (Chatterbox venv) and the
    nvidia-* pip wheels ship them - register those directories so no system CUDA install is
    required."""
    if sys.platform != "win32":
        return
    candidates = []
    try:
        import torch  # noqa: F401
        candidates.append(Path(torch.__file__).parent / "lib")
    except Exception:
        pass
    site = Path(sys.prefix) / "Lib" / "site-packages" / "nvidia"
    if site.is_dir():
        candidates.extend(p / "bin" for p in site.iterdir())
    for directory in candidates:
        if directory.is_dir():
            try:
                os.add_dll_directory(str(directory))
                os.environ["PATH"] = f"{directory}{os.pathsep}{os.environ.get('PATH', '')}"
            except OSError:
                pass


def cuda_available():
    try:
        import ctranslate2
        return ctranslate2.get_cuda_device_count() > 0
    except Exception:
        return False


def resolve_config():
    requested = os.environ.get("STT_DEVICE", "auto").lower()
    device = "cuda" if requested == "cuda" or (requested == "auto" and cuda_available()) else "cpu"
    compute = os.environ.get("STT_COMPUTE_TYPE") or ("float16" if device == "cuda" else "int8")
    model = os.environ.get("STT_MODEL") or ("large-v3-turbo" if device == "cuda" else "base")
    return device, compute, model


def load_model():
    global _model, _model_name, _device, _compute_type, _load_error
    from faster_whisper import WhisperModel

    device, compute, name = resolve_config()
    threads = int(os.environ.get("STT_CPU_THREADS") or max(4, (os.cpu_count() or 8) // 2))
    started = time.time()
    try:
        _model = WhisperModel(name, device=device, compute_type=compute, cpu_threads=threads)
    except Exception as error:  # CUDA libs missing/broken -> still usable on CPU
        if device != "cuda":
            raise
        log(f"CUDA load failed ({error}) - falling back to CPU")
        device, compute = "cpu", "int8"
        if not os.environ.get("STT_MODEL"):
            name = "base"
        _model = WhisperModel(name, device=device, compute_type=compute, cpu_threads=threads)
    _model_name, _device, _compute_type, _load_error = name, device, compute, None
    # Warmup: the first CUDA inference pays kernel/cuBLAS init (~1s) - don't bill the user for it.
    try:
        import numpy as np
        list(_model.transcribe(np.zeros(16000, dtype=np.float32), language="de", beam_size=1)[0])
    except Exception as error:  # noqa: BLE001
        log(f"Warmup skipped: {error}")
    log(f"Model {name} loaded on {device}/{compute} (threads={threads}) in {time.time() - started:.1f}s")


def ensure_model():
    global _load_error
    if _model is None:
        try:
            load_model()
        except Exception as error:
            _load_error = str(error)
            raise


def health_payload():
    return {"status": "ok", "modelLoaded": _model is not None, "model": _model_name, "device": _device,
            "computeType": _compute_type, "cudaAvailable": cuda_available(), "busy": _busy,
            "error": _load_error, "metrics": dict(_metrics)}


@app.route("/health", methods=["GET"])
def health():
    return jsonify(health_payload())


@app.route("/model/load", methods=["POST"])
def model_load():
    try:
        with _lock:
            ensure_model()
        return jsonify(health_payload())
    except Exception as error:
        return jsonify({"error": str(error)}), 500


@app.route("/model/unload", methods=["POST"])
def model_unload():
    global _model
    with _lock:
        _model = None
        gc.collect()
    return jsonify(health_payload())


@app.route("/transcribe", methods=["POST"])
def transcribe():
    """Body: raw audio bytes (webm/ogg/wav/mp4 - decoded via PyAV, no ffmpeg binary needed).
    Query: language (e.g. "de", empty/"auto" = detect), partial=1 for cheap live previews."""
    global _busy
    audio = request.get_data()
    if not audio:
        return jsonify({"error": "empty audio"}), 400
    language = (request.args.get("language") or "").strip() or None
    if language == "auto":
        language = None
    partial = request.args.get("partial") == "1"
    beam = int(os.environ.get("STT_BEAM_SIZE", "1"))
    try:
        with _lock:
            ensure_model()
            _busy = True
            started = time.time()
            segments, info = _model.transcribe(
                io.BytesIO(audio), language=language, beam_size=beam,
                # VAD drops leading/trailing silence and pauses - less audio to decode.
                vad_filter=True, vad_parameters={"min_silence_duration_ms": 500},
                condition_on_previous_text=False, without_timestamps=True,
                temperature=0.0 if partial else [0.0, 0.2, 0.4],
            )
            text = " ".join(segment.text.strip() for segment in segments).strip()
            elapsed_ms = int((time.time() - started) * 1000)
    except Exception as error:  # noqa: BLE001 - always answer with JSON
        log(f"Transcription failed: {error}")
        return jsonify({"error": f"Transcription failed: {error}"}), 500
    finally:
        _busy = False
    duration = float(getattr(info, "duration", 0) or 0) if "info" in locals() else 0
    if not partial:
        _metrics.update(lastAudioSeconds=round(duration, 2), lastTranscribeMs=elapsed_ms,
                        lastRealtimeFactor=round(elapsed_ms / 1000 / duration, 3) if duration else None)
        _metrics["requests"] += 1
        log(f"chars={len(text)} audio_s={duration:.2f} ms={elapsed_ms}")
    return jsonify({"text": text, "language": getattr(info, "language", language),
                    "audioSeconds": duration, "elapsedMs": elapsed_ms})


def main():
    add_cuda_dll_dirs()
    host = os.environ.get("STT_HOST", "127.0.0.1")
    port = int(os.environ.get("STT_PORT", "8891"))
    if os.environ.get("STT_LAZY_LOAD") != "1":
        ensure_model()
    try:
        from waitress import serve
        log(f"Serving on http://{host}:{port}")
        serve(app, host=host, port=port, threads=4)
    except ImportError:
        app.run(host=host, port=port, threaded=True)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(0)
