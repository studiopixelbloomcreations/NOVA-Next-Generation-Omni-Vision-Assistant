"""NOVA Tool SDK.

A small, explicit capability surface for AI-generated Python tools.
Generated tools import this module instead of importing OS primitives directly.
The implementation is real on the production machine; the Forge sandbox injects
an isolated SDK shim so validation never touches the host.
"""
from __future__ import annotations

import base64
import ctypes
import ctypes.wintypes as wintypes
import json
import os
import platform
import subprocess
import time
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional


class ToolCapabilityError(RuntimeError):
    pass


def _ok(**data: Any) -> Dict[str, Any]:
    return {"success": True, **data}


def _fail(message: str, **data: Any) -> Dict[str, Any]:
    return {"success": False, "error": message, **data}


def _capabilities(params: Optional[Dict[str, Any]]) -> set[str]:
    raw = (params or {}).get("_nova_capabilities", [])
    return {str(x).upper() for x in raw} if isinstance(raw, list) else set()


def require(capability: str, params: Optional[Dict[str, Any]]) -> None:
    allowed = _capabilities(params)
    if allowed and capability.upper() not in allowed and "*" not in allowed:
        raise ToolCapabilityError(f"tool capability '{capability}' was not granted")


def system_info(params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    require("SYSTEM_READ", params)
    result: Dict[str, Any] = {
        "platform": platform.platform(),
        "system": platform.system(),
        "release": platform.release(),
        "machine": platform.machine(),
        "python": platform.python_version(),
        "hostname": platform.node(),
    }
    if os.name == "nt":
        try:
            class MEMORYSTATUSEX(ctypes.Structure):
                _fields_ = [("dwLength", wintypes.DWORD), ("dwMemoryLoad", wintypes.DWORD),
                            ("ullTotalPhys", ctypes.c_ulonglong), ("ullAvailPhys", ctypes.c_ulonglong),
                            ("ullTotalPageFile", ctypes.c_ulonglong), ("ullAvailPageFile", ctypes.c_ulonglong),
                            ("ullTotalVirtual", ctypes.c_ulonglong), ("ullAvailVirtual", ctypes.c_ulonglong),
                            ("ullAvailExtendedVirtual", ctypes.c_ulonglong)]
            mem = MEMORYSTATUSEX()
            mem.dwLength = ctypes.sizeof(MEMORYSTATUSEX)
            ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(mem))
            result.update({"memoryLoadPercent": int(mem.dwMemoryLoad),
                           "totalRamGb": round(mem.ullTotalPhys / 2**30, 2),
                           "availableRamGb": round(mem.ullAvailPhys / 2**30, 2)})
        except Exception:
            pass
    return _ok(**result)


def active_window(params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    require("WINDOW_INSPECT", params)
    if os.name != "nt":
        return _fail("active window inspection is currently implemented for Windows")
    hwnd = ctypes.windll.user32.GetForegroundWindow()
    pid = wintypes.DWORD()
    ctypes.windll.user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
    length = ctypes.windll.user32.GetWindowTextLengthW(hwnd)
    buf = ctypes.create_unicode_buffer(length + 1)
    ctypes.windll.user32.GetWindowTextW(hwnd, buf, length + 1)
    return _ok(hwnd=int(hwnd), pid=int(pid.value), title=buf.value or "(no title)")


def launch(app_or_path: str, params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    require("APP_LAUNCH", params)
    target = str(app_or_path).strip()
    if not target:
        return _fail("application target is empty")
    try:
        if os.name == "nt":
            os.startfile(target)  # type: ignore[attr-defined]
        else:
            subprocess.Popen([target], start_new_session=True)
        return _ok(target=target)
    except Exception as exc:
        return _fail(str(exc), target=target)


def close_process(name_or_pid: str | int, params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    require("PROCESS_CONTROL", params)
    if os.name != "nt":
        return _fail("process control is currently implemented for Windows")
    target = str(name_or_pid)
    try:
        completed = subprocess.run(["taskkill", "/F", "/PID", target] if target.isdigit()
                                   else ["taskkill", "/F", "/IM", target],
                                   capture_output=True, text=True, timeout=10)
        if completed.returncode != 0:
            return _fail((completed.stderr or completed.stdout or "taskkill failed").strip(), target=target)
        return _ok(target=target, output=completed.stdout.strip())
    except Exception as exc:
        return _fail(str(exc), target=target)


def type_text(text: str, params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    require("INPUT_CONTROL", params)
    if os.name != "nt":
        return _fail("keyboard automation is currently implemented for Windows")
    # Use PowerShell's SendKeys only through the curated SDK; generated tools
    # never receive access to subprocess directly.
    escaped = str(text).replace("'", "''")
    script = f"$ws=New-Object -ComObject WScript.Shell; $ws.SendKeys('{escaped}')"
    try:
        subprocess.run(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script],
                       capture_output=True, text=True, timeout=10, check=True)
        return _ok(chars=len(str(text)))
    except Exception as exc:
        return _fail(str(exc))


def key_press(keys: str, params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    require("INPUT_CONTROL", params)
    return type_text(keys, params)


def clipboard_get(params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    require("CLIPBOARD", params)
    if os.name != "nt":
        return _fail("clipboard access is currently implemented for Windows")
    try:
        completed = subprocess.run(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", "Get-Clipboard"],
                                   capture_output=True, text=True, timeout=10, check=True)
        return _ok(text=completed.stdout.rstrip("\r\n"))
    except Exception as exc:
        return _fail(str(exc))


def clipboard_set(text: str, params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    require("CLIPBOARD", params)
    if os.name != "nt":
        return _fail("clipboard access is currently implemented for Windows")
    try:
        subprocess.run(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", "Set-Clipboard -Value $input"],
                       input=str(text), capture_output=True, text=True, timeout=10, check=True)
        return _ok(length=len(str(text)))
    except Exception as exc:
        return _fail(str(exc))


def file_read(file_path: str, params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    require("FS_READ", params)
    p = Path(file_path).expanduser().resolve()
    try:
        text = p.read_text(encoding="utf-8")
        return _ok(path=str(p), text=text)
    except Exception as exc:
        return _fail(str(exc), path=str(p))


def file_write(file_path: str, content: str, params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    require("FS_WRITE", params)
    p = Path(file_path).expanduser().resolve()
    try:
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(str(content), encoding="utf-8")
        return _ok(path=str(p), bytes=len(str(content).encode("utf-8")))
    except Exception as exc:
        return _fail(str(exc), path=str(p))


def screenshot(params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    require("SCREEN_CAPTURE", params)
    # Reuse the OS PrintScreen path to keep the SDK dependency-light. The
    # production NOVA built-in capture remains preferred for rich images.
    if os.name != "nt":
        return _fail("screen capture is currently implemented for Windows")
    try:
        import PIL.ImageGrab  # type: ignore
        image = PIL.ImageGrab.grab(all_screens=True)
        from io import BytesIO
        buf = BytesIO()
        image.save(buf, format="PNG")
        return _ok(data=base64.b64encode(buf.getvalue()).decode("ascii"), mimeType="image/png",
                   width=image.width, height=image.height)
    except Exception as exc:
        return _fail(str(exc))


def web_get(url: str, params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    require("WEB_READ", params)
    parsed = urllib.parse.urlparse(str(url))
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        return _fail("only http(s) URLs are supported")
    try:
        request = urllib.request.Request(str(url), headers={"User-Agent": "NOVA-Genesis/1.0"})
        with urllib.request.urlopen(request, timeout=15) as response:
            body = response.read(2 * 1024 * 1024).decode("utf-8", errors="replace")
        return _ok(url=str(url), status=200, text=body)
    except Exception as exc:
        return _fail(str(exc), url=str(url))


def sleep(seconds: float, params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    value = max(0.0, min(float(seconds), 30.0))
    time.sleep(value)
    return _ok(seconds=value)


__all__ = [
    "ToolCapabilityError", "system_info", "active_window", "launch", "close_process",
    "type_text", "key_press", "clipboard_get", "clipboard_set", "file_read", "file_write",
    "screenshot", "web_get", "sleep", "require",
]
