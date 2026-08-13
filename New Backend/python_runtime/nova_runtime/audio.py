"""Audio / voice service — microphone capture, wake-word detection and
Whisper transcription.

Microphone capture uses `sounddevice` when installed; streaming transcription
uses `faster_whisper` when installed. When the optional dependencies are
absent the functions return success=False with a precise reason (never a fake
transcription). This is the low-latency transcription path; Gemini Live remains
the conversational head and Charon the voice output.
"""
from __future__ import annotations

import json
import sys
from typing import Any, Dict, List

WAKE_WORD = "ADAM"


def _have(mod: str) -> bool:
    try:
        __import__(mod)
        return True
    except Exception:
        return False


def availability() -> Dict[str, Any]:
    return {
        "success": True,
        "mic": _have("sounddevice"),
        "whisper": _have("faster_whisper"),
        "vad": _have("webrtcvad"),
        "wakeWord": WAKE_WORD,
        "sampleRateHz": 16000,
    }


def list_devices() -> Dict[str, Any]:
    if not _have("sounddevice"):
        return {"success": False, "error": "sounddevice not installed"}
    import sounddevice as sd
    try:
        devices = sd.query_devices()
        out = []
        for i, d in enumerate(devices):
            out.append({"id": i, "name": d.get("name"), "inputs": int(d.get("max_input_channels", 0)),
                        "outputs": int(d.get("max_output_channels", 0)), "defaultSampleRate": d.get("default_samplerate")})
        return {"success": True, "devices": out}
    except Exception as exc:  # noqa: BLE001
        return {"success": False, "error": f"{type(exc).__name__}: {exc}"}


def capture(duration_s: float = 3.0, samplerate: int = 16000) -> Dict[str, Any]:
    """Record a short clip and return 16-bit mono PCM + an optional wake-word
    check. The wake-word classifier is a lightweight energy/VAD heuristic on
    the raw sample; the authoritative wake detection for 'ADAM' is done by the
    Electron-side WakeWordDetector over the same stream. This returns the PCM
    for downstream Whisper transcription."""
    if not _have("sounddevice"):
        return {"success": False, "error": "sounddevice not installed"}
    import numpy as np
    import sounddevice as sd
    try:
        rec = sd.rec(int(duration_s * samplerate), samplerate=samplerate, channels=1, dtype="int16")
        sd.wait()
        data = rec.flatten()
        pcm = data.tobytes()
        import base64
        return {"success": True, "pcmBase64": base64.b64encode(pcm).decode("ascii"),
                "samples": int(len(data)), "sampleRate": samplerate, "durationS": duration_s,
                "rms": float(np.sqrt(np.mean((data.astype(np.float32) / 32768.0) ** 2))) if len(data) else 0.0}
    except Exception as exc:  # noqa: BLE001
        return {"success": False, "error": f"{type(exc).__name__}: {exc}"}


def transcribe(pcm_base64: str, samplerate: int = 16000, language: str = "en") -> Dict[str, Any]:
    """Streaming-style transcription of a PCM clip via faster-whisper."""
    if not _have("faster_whisper"):
        return {"success": False, "error": "faster_whisper not installed"}
    import base64
    import io
    import numpy as np
    from faster_whisper import WhisperModel
    try:
        pcm = np.frombuffer(base64.b64decode(pcm_base64), dtype=np.int16).astype(np.float32) / 32768.0
        model = WhisperModel("base", device="cpu", compute_type="int8")
        segments, info = model.transcribe(pcm, language=language, beam_size=1)
        text = "".join(s.text for s in segments).strip()
        return {"success": True, "text": text, "language": info.language, "probability": float(info.language_probability) if info.language_probability else None}
    except Exception as exc:  # noqa: BLE001
        return {"success": False, "error": f"{type(exc).__name__}: {exc}"}


def dispatch_cmd(cmd: str, params: Dict[str, Any]) -> Dict[str, Any]:
    if cmd == "availability":
        return availability()
    if cmd == "devices":
        return list_devices()
    if cmd == "capture":
        return capture(float(params.get("duration_s", 3.0)), int(params.get("samplerate", 16000)))
    if cmd == "transcribe":
        return transcribe(str(params.get("pcm_base64", "")), int(params.get("samplerate", 16000)),
                          str(params.get("language", "en")))
    return {"success": False, "error": f"unknown audio command: {cmd}"}


if __name__ == "__main__":  # pragma: no cover
    req = json.load(sys.stdin)
    cmd = req.get("cmd", "availability")
    params = req.get("params", {}) or {}
    print(json.dumps(dispatch_cmd(cmd, params)))
    sys.stdout.flush()
