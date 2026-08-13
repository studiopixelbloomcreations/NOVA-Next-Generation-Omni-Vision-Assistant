"""Windows automation service — REAL Win32 operations on a Windows host.

Uses ctypes against user32/kernel32 for window, process and system control,
and optional deps (Pillow, pyautogui, sounddevice) when present. Every function
returns a JSON-serializable dict with a "success" flag. Nothing here fabricates
success: if the underlying call fails or the platform is not Windows, it
returns success=False with a real reason.
"""
from __future__ import annotations

import json
import os
import platform
import subprocess
import sys
from typing import Any, Dict, List

IS_WINDOWS = platform.system() == "Windows"


def _is_win() -> bool:
    return IS_WINDOWS


def availability() -> Dict[str, Any]:
    """Report which Windows capabilities are actually available."""
    caps: Dict[str, Any] = {}
    if _is_win():
        import ctypes
        caps["user32"] = True
        caps["kernel32"] = True
        caps["screenshot"] = _have("PIL") or _have("mss")
        caps["automation"] = _have("pyautogui")
        caps["mic"] = _have("sounddevice")
        caps["ocr"] = _have("pytesseract") and _have("PIL")
    else:
        caps["user32"] = False
        caps["kernel32"] = False
        caps["screenshot"] = False
        caps["automation"] = False
        caps["mic"] = False
        caps["ocr"] = False
    return {"success": True, "windows": _is_win(), "capabilities": caps}


def _have(mod: str) -> bool:
    try:
        __import__(mod)
        return True
    except Exception:
        return False


def active_window() -> Dict[str, Any]:
    if not _is_win():
        return {"success": False, "error": "not on Windows"}
    import ctypes
    import ctypes.wintypes as wt
    try:
        hwnd = ctypes.windll.user32.GetForegroundWindow()
        pid = wt.DWORD()
        ctypes.windll.user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        length = ctypes.windll.user32.GetWindowTextLengthW(hwnd)
        buf = ctypes.create_unicode_buffer(length + 1)
        ctypes.windll.user32.GetWindowTextW(hwnd, buf, length + 1)
        # Class name
        cls = ctypes.create_unicode_buffer(256)
        ctypes.windll.user32.GetClassNameW(hwnd, cls, 256)
        return {"success": True, "title": buf.value or "(no title)", "pid": int(pid.value), "hwnd": int(hwnd), "className": cls.value}
    except Exception as exc:  # noqa: BLE001
        return {"success": False, "error": f"{type(exc).__name__}: {exc}"}


def launch(target: str, args: str = "") -> Dict[str, Any]:
    """Launch an application by name/command or a Windows App-User-Model ID."""
    if not _is_win():
        return {"success": False, "error": "not on Windows"}
    try:
        cmd = target.strip()
        if args:
            cmd = f"{cmd} {args}"
        # Try shell execute (handles start commands, URLs, UWP aliases).
        info = subprocess.STARTUPINFO() if hasattr(subprocess, "STARTUPINFO") else None
        proc = subprocess.Popen(cmd, shell=True, startupinfo=info,
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        # Give it a moment then confirm a process exists.
        import time
        time.sleep(0.6)
        exists = _process_alive(proc.pid) if proc.pid else False
        return {"success": True, "pid": proc.pid, "command": cmd, "confirmedRunning": exists}
    except Exception as exc:  # noqa: BLE001
        return {"success": False, "error": f"{type(exc).__name__}: {exc}"}


def _process_alive(pid: int) -> bool:
    import ctypes
    try:
        SYNCHRONIZE = 0x00100000
        handle = ctypes.windll.kernel32.OpenProcess(SYNCHRONIZE, False, int(pid))
        if not handle:
            return False
        result = ctypes.windll.kernel32.WaitForSingleObject(handle, 0)
        ctypes.windll.kernel32.CloseHandle(handle)
        return result == 0x00000102  # WAIT_TIMEOUT -> still running
    except Exception:
        return False


def processes(limit: int = 50) -> Dict[str, Any]:
    if not _is_win():
        return {"success": False, "error": "not on Windows"}
    try:
        out = subprocess.run(
            ["powershell", "-NoProfile", "-Command",
             f"Get-Process | Sort-Object WS -Descending | Select-Object -First {int(limit)} ProcessName,Id,WS | ConvertTo-Json -Compress"],
            capture_output=True, text=True, timeout=10,
        )
        import json as _j
        data = _j.loads(out.stdout or "[]")
        arr = data if isinstance(data, list) else [data]
        items = []
        for p in arr:
            if p and p.get("ProcessName"):
                items.append({"name": p.get("ProcessName"), "pid": int(p.get("Id", 0)),
                              "workingSetMb": round((p.get("WS") or 0) / (1024 * 1024), 1)})
        return {"success": True, "processes": items}
    except Exception as exc:  # noqa: BLE001
        return {"success": False, "error": f"{type(exc).__name__}: {exc}"}


def screenshot(monitor: int = 0, path: str = "") -> Dict[str, Any]:
    if not _is_win():
        return {"success": False, "error": "not on Windows"}
    if not (_have("mss") or _have("PIL")):
        return {"success": False, "error": "screenshot requires Pillow or mss"}
    try:
        if _have("mss"):
            import mss
            with mss.mss() as sct:
                mon = sct.monitors[monitor] if 0 <= monitor < len(sct.monitors) else sct.monitors[0]
                shot = sct.grab(mon)
                from PIL import Image
                img = Image.frombytes("RGB", shot.size, shot.rgb)
        else:
            from PIL import ImageGrab
            img = ImageGrab.grab(all_screens=True) if monitor == 0 else ImageGrab.grab()
        if path:
            img.save(path)
            size = os.path.getsize(path)
            return {"success": True, "path": path, "sizeBytes": size, "width": img.width, "height": img.height}
        # Return base64 PNG for in-workspace display.
        import io
        import base64
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        b64 = base64.b64encode(buf.getvalue()).decode("ascii")
        return {"success": True, "width": img.width, "height": img.height, "mime": "image/png", "dataBase64": b64}
    except Exception as exc:  # noqa: BLE001
        return {"success": False, "error": f"{type(exc).__name__}: {exc}"}


def clipboard_read() -> Dict[str, Any]:
    if not _is_win():
        return {"success": False, "error": "not on Windows"}
    try:
        subprocess.run(["clip.exe"], input=b"", timeout=3)  # ensure clipboard service available
    except Exception:
        pass
    try:
        import ctypes
        CF_UNICODETEXT = 13
        ctypes.windll.user32.OpenClipboard(0)
        try:
            handle = ctypes.windll.user32.GetClipboardData(CF_UNICODETEXT)
            if handle:
                ptr = ctypes.windll.kernel32.GlobalLock(handle)
                text = ctypes.wstring_at(ptr)
                ctypes.windll.kernel32.GlobalUnlock(handle)
                ctypes.windll.user32.CloseClipboard()
                return {"success": True, "text": text}
        finally:
            ctypes.windll.user32.CloseClipboard()
        return {"success": True, "text": ""}
    except Exception as exc:  # noqa: BLE001
        return {"success": False, "error": f"{type(exc).__name__}: {exc}"}


def clipboard_write(text: str) -> Dict[str, Any]:
    if not _is_win():
        return {"success": False, "error": "not on Windows"}
    try:
        proc = subprocess.run(["clip.exe"], input=str(text).encode("utf-16-le"), timeout=5)
        return {"success": proc.returncode == 0}
    except Exception as exc:  # noqa: BLE001
        return {"success": False, "error": f"{type(exc).__name__}: {exc}"}


def keyboard_type(text: str) -> Dict[str, Any]:
    if not _have("pyautogui"):
        return {"success": False, "error": "keyboard automation requires pyautogui"}
    try:
        import pyautogui
        pyautogui.write(str(text), interval=0.005)
        return {"success": True}
    except Exception as exc:  # noqa: BLE001
        return {"success": False, "error": f"{type(exc).__name__}: {exc}"}


def keyboard_hotkey(combo: str) -> Dict[str, Any]:
    if not _have("pyautogui"):
        return {"success": False, "error": "keyboard automation requires pyautogui"}
    try:
        import pyautogui
        pyautogui.hotkey(*[k.strip() for k in str(combo).split(",") if k.strip()])
        return {"success": True}
    except Exception as exc:  # noqa: BLE001
        return {"success": False, "error": f"{type(exc).__name__}: {exc}"}


def mouse_click(x: int, y: int, button: str = "left", clicks: int = 1) -> Dict[str, Any]:
    if not _have("pyautogui"):
        return {"success": False, "error": "mouse automation requires pyautogui"}
    try:
        import pyautogui
        pyautogui.click(int(x), int(y), button=str(button), clicks=int(clicks))
        return {"success": True}
    except Exception as exc:  # noqa: BLE001
        return {"success": False, "error": f"{type(exc).__name__}: {exc}"}


def dispatch_cmd(cmd: str, params: Dict[str, Any]) -> Dict[str, Any]:
    if cmd == "availability":
        return availability()
    if cmd == "active-window":
        return active_window()
    if cmd == "launch":
        return launch(str(params.get("target", "")), str(params.get("args", "")))
    if cmd == "processes":
        return processes(int(params.get("limit", 50)))
    if cmd == "screenshot":
        return screenshot(int(params.get("monitor", 0)), str(params.get("path", "")))
    if cmd == "clipboard-read":
        return clipboard_read()
    if cmd == "clipboard-write":
        return clipboard_write(str(params.get("text", "")))
    if cmd == "keyboard-type":
        return keyboard_type(str(params.get("text", "")))
    if cmd == "keyboard-hotkey":
        return keyboard_hotkey(str(params.get("combo", "")))
    if cmd == "mouse-click":
        return mouse_click(int(params.get("x", 0)), int(params.get("y", 0)),
                           str(params.get("button", "left")), int(params.get("clicks", 1)))
    return {"success": False, "error": f"unknown win command: {cmd}"}


if __name__ == "__main__":  # pragma: no cover
    req = json.load(sys.stdin)
    cmd = req.get("cmd", "availability")
    params = req.get("params", {}) or {}
    print(json.dumps(dispatch_cmd(cmd, params)))
    sys.stdout.flush()
