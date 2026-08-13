"""Charon TTS service — text-to-speech output on Windows.

Uses the Windows SAPI via win32com (available on Windows with pywin32) for
real spoken output, or pyttsx3 when present. When no TTS backend is available
the function returns success=False honestly. Voice identity is Charon; the
voice selector chooses a natural Windows voice. This never fabricates speech.
"""
from __future__ import annotations

import json
import platform
import sys
from typing import Any, Dict


def availability() -> Dict[str, Any]:
    have_sapi = False
    have_pyttsx3 = False
    try:
        import win32com.client  # noqa: F401
        have_sapi = platform.system() == "Windows"
    except Exception:
        pass
    try:
        import pyttsx3  # noqa: F401
        have_pyttsx3 = True
    except Exception:
        pass
    return {"success": True, "sapi": have_sapi, "pyttsx3": have_pyttsx3, "voice": "Charon"}


def speak(text: str, rate: int = 0) -> Dict[str, Any]:
    text = str(text or "")
    if not text.strip():
        return {"success": False, "error": "empty text"}
    # SAPI (preferred on Windows).
    try:
        import win32com.client
        import pythoncom
        if platform.system() == "Windows":
            pythoncom.CoInitialize()
            speaker = win32com.client.Dispatch("SAPI.SpVoice")
            if rate:
                try:
                    speaker.Rate = int(rate)
                except Exception:
                    pass
            speaker.Speak(text)
            return {"success": True, "backend": "sapi"}
    except Exception:
        pass
    # pyttsx3 fallback.
    try:
        import pyttsx3
        engine = pyttsx3.init()
        if rate:
            engine.setProperty("rate", rate)
        engine.say(text)
        engine.runAndWait()
        return {"success": True, "backend": "pyttsx3"}
    except Exception as exc:  # noqa: BLE001
        return {"success": False, "error": f"no TTS backend available: {type(exc).__name__}: {exc}"}


def voices() -> Dict[str, Any]:
    try:
        import win32com.client
        import pythoncom
        if platform.system() == "Windows":
            pythoncom.CoInitialize()
            speaker = win32com.client.Dispatch("SAPI.SpVoice")
            out = []
            for v in speaker.GetVoices():
                out.append(v.GetDescription())
            return {"success": True, "voices": out}
    except Exception:
        pass
    try:
        import pyttsx3
        engine = pyttsx3.init()
        out = [str(v.id) for v in engine.getProperty("voices")]
        return {"success": True, "voices": out}
    except Exception as exc:  # noqa: BLE001
        return {"success": False, "error": str(exc)}


def dispatch_cmd(cmd: str, params: Dict[str, Any]) -> Dict[str, Any]:
    if cmd == "availability":
        return availability()
    if cmd == "speak":
        return speak(str(params.get("text", "")), int(params.get("rate", 0)))
    if cmd == "voices":
        return voices()
    return {"success": False, "error": f"unknown tts command: {cmd}"}


if __name__ == "__main__":  # pragma: no cover
    req = json.load(sys.stdin)
    cmd = req.get("cmd", "availability")
    params = req.get("params", {}) or {}
    print(json.dumps(dispatch_cmd(cmd, params)))
    sys.stdout.flush()
