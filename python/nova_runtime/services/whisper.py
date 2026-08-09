"""Low-latency in-memory Whisper streaming service.

The worker owns the model and audio buffer. Electron sends small PCM16 chunks;
no WAV files or temporary recordings are used. faster-whisper is optional at
import time so the rest of NOVA can still boot when the package/model is not
available.
"""
import base64
import os
import time
from typing import Any, Dict

import numpy as np

try:
    from faster_whisper import WhisperModel
except Exception:  # pragma: no cover - exercised on machines without extras
    WhisperModel = None

_model = None
_audio = bytearray()
_last_decode = 0.0
_last_text = ""
_model_started = 0.0
STREAM_WINDOW_SECONDS = 4
PARTIAL_INTERVAL_SECONDS = 0.20


def _model_name() -> str:
    return os.environ.get("NOVA_WHISPER_MODEL", "tiny.en")


def _get_model():
    global _model, _model_started
    if _model is not None:
        return _model
    if WhisperModel is None:
        raise RuntimeError("faster-whisper is not installed")
    _model_started = time.perf_counter()
    device = os.environ.get("NOVA_WHISPER_DEVICE", "cpu").lower()
    compute = os.environ.get("NOVA_WHISPER_COMPUTE_TYPE", "int8")
    if device == "auto":
        device = "cpu"
    try:
        _model = WhisperModel(_model_name(), device=device, compute_type=compute)
    except Exception:
        if device != "cpu":
            _model = WhisperModel(_model_name(), device="cpu", compute_type="int8")
        else:
            raise
    return _model


def _decode(force: bool = False) -> Dict[str, Any]:
    global _last_decode, _last_text
    now = time.perf_counter()
    if not force and now - _last_decode < PARTIAL_INTERVAL_SECONDS:
        return {"ready": True, "text": _last_text, "partial": True, "skipped": True}
    # Decode a short rolling window to keep latency bounded.
    samples = np.frombuffer(bytes(_audio[-16000 * STREAM_WINDOW_SECONDS * 2:]), dtype=np.int16).astype(np.float32) / 32768.0
    if samples.size < 1600:
        return {"ready": True, "text": _last_text, "partial": True, "skipped": True}
    started = time.perf_counter()
    segments, _ = _get_model().transcribe(
        samples,
        language="en" if _model_name().endswith(".en") else None,
        beam_size=1,
        best_of=1,
        temperature=0.0,
        without_timestamps=True,
        vad_filter=False,
        condition_on_previous_text=False,
    )
    text = " ".join(segment.text.strip() for segment in segments).strip()
    _last_decode = now
    _last_text = text
    return {
        "ready": True,
        "text": text,
        "partial": not force,
        "decode_ms": round((time.perf_counter() - started) * 1000, 1),
        "model_load_ms": round((started - _model_started) * 1000, 1) if _model_started else 0,
    }


def status() -> Dict[str, Any]:
    return {
        "available": WhisperModel is not None,
        "model": _model_name(),
        "loaded": _model is not None,
        "device": os.environ.get("NOVA_WHISPER_DEVICE", "cpu"),
    }


def warmup() -> Dict[str, Any]:
    started = time.perf_counter()
    _get_model()
    return {
        "ready": True,
        "model": _model_name(),
        "load_ms": round((time.perf_counter() - started) * 1000, 1),
    }


def audio(p: Dict[str, Any]) -> Dict[str, Any]:
    global _audio
    raw = base64.b64decode(str(p.get("pcm_base64", "")))
    if raw:
        _audio.extend(raw)
    # Keep at most six seconds in memory.
    del _audio[:-16000 * 6 * 2]
    return _decode(bool(p.get("speech_end", False)))


def reset() -> Dict[str, Any]:
    global _audio, _last_text, _last_decode
    _audio = bytearray()
    _last_text = ""
    _last_decode = 0.0
    return {"ready": True}
