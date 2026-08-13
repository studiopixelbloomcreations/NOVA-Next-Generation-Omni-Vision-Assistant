"""NOVA Tool SDK.

A curated, real capability surface for AI-generated Python tools. Generated
source imports this module instead of importing arbitrary OS primitives.
Forge validation injects a non-destructive shim; registered production tools
receive the real implementation on the user's Windows machine.
"""
from __future__ import annotations

import base64
import ctypes
import ctypes.wintypes as wintypes
import os
import platform
import subprocess
import time
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Dict, Optional

class ToolCapabilityError(RuntimeError): pass

def _ok(**data: Any) -> Dict[str, Any]: return {"success": True, **data}
def _fail(message: str, **data: Any) -> Dict[str, Any]: return {"success": False, "error": message, **data}
def _capabilities(params: Optional[Dict[str, Any]]) -> set[str]:
    raw = (params or {}).get("_nova_capabilities", [])
    return {str(x).upper() for x in raw} if isinstance(raw, list) else set()
def require(capability: str, params: Optional[Dict[str, Any]]) -> None:
    allowed = _capabilities(params)
    if allowed and capability.upper() not in allowed and "*" not in allowed:
        raise ToolCapabilityError(f"tool capability '{capability}' was not granted")

def system_info(params=None):
    require("SYSTEM_READ", params)
    result = {"platform": platform.platform(), "system": platform.system(), "release": platform.release(), "machine": platform.machine(), "python": platform.python_version(), "hostname": platform.node()}
    if os.name == "nt":
        try:
            class MEMORYSTATUSEX(ctypes.Structure):
                _fields_ = [("dwLength", wintypes.DWORD), ("dwMemoryLoad", wintypes.DWORD), ("ullTotalPhys", ctypes.c_ulonglong), ("ullAvailPhys", ctypes.c_ulonglong), ("ullTotalPageFile", ctypes.c_ulonglong), ("ullAvailPageFile", ctypes.c_ulonglong), ("ullTotalVirtual", ctypes.c_ulonglong), ("ullAvailVirtual", ctypes.c_ulonglong), ("ullAvailExtendedVirtual", ctypes.c_ulonglong)]
            mem = MEMORYSTATUSEX(); mem.dwLength = ctypes.sizeof(MEMORYSTATUSEX); ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(mem))
            result.update({"memoryLoadPercent": int(mem.dwMemoryLoad), "totalRamGb": round(mem.ullTotalPhys / 2**30, 2), "availableRamGb": round(mem.ullAvailPhys / 2**30, 2)})
        except Exception: pass
    return _ok(**result)

def active_window(params=None):
    require("WINDOW_INSPECT", params)
    if os.name != "nt": return _fail("active window inspection is currently implemented for Windows")
    hwnd = ctypes.windll.user32.GetForegroundWindow(); pid = wintypes.DWORD(); ctypes.windll.user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
    length = ctypes.windll.user32.GetWindowTextLengthW(hwnd); buf = ctypes.create_unicode_buffer(length + 1); ctypes.windll.user32.GetWindowTextW(hwnd, buf, length + 1)
    return _ok(hwnd=int(hwnd), pid=int(pid.value), title=buf.value or "(no title)")

def window_list(params=None):
    require("WINDOW_INSPECT", params)
    if os.name != "nt": return _fail("window enumeration is currently implemented for Windows")
    items = []; limit = int((params or {}).get("limit", 50)); Proc = ctypes.WINFUNCTYPE(ctypes.c_bool, wintypes.HWND, wintypes.LPARAM)
    def cb(hwnd, _):
        if not ctypes.windll.user32.IsWindowVisible(hwnd): return True
        n = ctypes.windll.user32.GetWindowTextLengthW(hwnd); buf = ctypes.create_unicode_buffer(n + 1); ctypes.windll.user32.GetWindowTextW(hwnd, buf, n + 1); title = buf.value.strip()
        if title: items.append({"hwnd": int(hwnd), "title": title})
        return len(items) < limit
    ctypes.windll.user32.EnumWindows(Proc(cb), 0); return _ok(windows=items)

def process_list(params=None):
    require("PROCESS_READ", params)
    try:
        p = subprocess.run(["tasklist", "/FO", "CSV", "/NH"], capture_output=True, text=True, timeout=10, check=True); return _ok(processes=p.stdout.splitlines()[:int((params or {}).get("limit", 50))])
    except Exception as exc: return _fail(str(exc))

def launch(app_or_path, params=None):
    require("APP_LAUNCH", params); target = str(app_or_path).strip()
    if not target: return _fail("application target is empty")
    try:
        if os.name == "nt": os.startfile(target)
        else: subprocess.Popen([target], start_new_session=True)
        return _ok(target=target)
    except Exception as exc: return _fail(str(exc), target=target)

def close_process(name_or_pid, params=None):
    require("PROCESS_CONTROL", params)
    if os.name != "nt": return _fail("process control is currently implemented for Windows")
    target = str(name_or_pid); command = ["taskkill", "/F", "/PID", target] if target.isdigit() else ["taskkill", "/F", "/IM", target]
    try:
        p = subprocess.run(command, capture_output=True, text=True, timeout=10)
        if p.returncode != 0: return _fail((p.stderr or p.stdout or "taskkill failed").strip(), target=target)
        return _ok(target=target, output=p.stdout.strip())
    except Exception as exc: return _fail(str(exc), target=target)

def window_focus(title, params=None):
    require("WINDOW_CONTROL", params)
    if os.name != "nt": return _fail("window control is currently implemented for Windows")
    script = "$ws=New-Object -ComObject WScript.Shell; if($ws.AppActivate($args[0])){'ok'}else{'not_found'}"
    try:
        p = subprocess.run(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script, str(title)], capture_output=True, text=True, timeout=10)
        return _ok(title=title) if "ok" in p.stdout else _fail("window not found", title=title)
    except Exception as exc: return _fail(str(exc))

def mouse_move(x, y, params=None):
    require("INPUT_CONTROL", params)
    if os.name != "nt": return _fail("mouse automation is currently implemented for Windows")
    ctypes.windll.user32.SetCursorPos(int(x), int(y)); return _ok(x=int(x), y=int(y))

def mouse_click(x=None, y=None, button="left", clicks=1, params=None):
    require("INPUT_CONTROL", params)
    if os.name != "nt": return _fail("mouse automation is currently implemented for Windows")
    if x is not None and y is not None: ctypes.windll.user32.SetCursorPos(int(x), int(y))
    flags = 0x0002 if button == "left" else 0x0008; up = 0x0004 if button == "left" else 0x0010
    for _ in range(max(1, min(int(clicks), 5))): ctypes.windll.user32.mouse_event(flags, 0, 0, 0, 0); ctypes.windll.user32.mouse_event(up, 0, 0, 0, 0)
    return _ok(x=x, y=y, button=button, clicks=clicks)

def mouse_scroll(clicks, params=None):
    require("INPUT_CONTROL", params)
    if os.name != "nt": return _fail("mouse automation is currently implemented for Windows")
    ctypes.windll.user32.mouse_event(0x0800, 0, 0, int(clicks) * 120, 0); return _ok(clicks=int(clicks))

def type_text(text, params=None):
    require("INPUT_CONTROL", params)
    if os.name != "nt": return _fail("keyboard automation is currently implemented for Windows")
    escaped = str(text).replace("'", "''"); script = f"$ws=New-Object -ComObject WScript.Shell; $ws.SendKeys('{escaped}')"
    try: subprocess.run(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script], capture_output=True, text=True, timeout=10, check=True); return _ok(chars=len(str(text)))
    except Exception as exc: return _fail(str(exc))

def key_press(keys, params=None): return type_text(keys, params)
def clipboard_get(params=None):
    require("CLIPBOARD", params)
    try: p = subprocess.run(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", "Get-Clipboard"], capture_output=True, text=True, timeout=10, check=True); return _ok(text=p.stdout.rstrip("\r\n"))
    except Exception as exc: return _fail(str(exc))
def clipboard_set(text, params=None):
    require("CLIPBOARD", params)
    try: subprocess.run(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", "Set-Clipboard -Value $input"], input=str(text), capture_output=True, text=True, timeout=10, check=True); return _ok(length=len(str(text)))
    except Exception as exc: return _fail(str(exc))
def file_read(file_path, params=None):
    require("FS_READ", params); p = Path(file_path).expanduser().resolve()
    try: return _ok(path=str(p), text=p.read_text(encoding="utf-8"))
    except Exception as exc: return _fail(str(exc), path=str(p))
def file_write(file_path, content, params=None):
    require("FS_WRITE", params); p = Path(file_path).expanduser().resolve()
    try: p.parent.mkdir(parents=True, exist_ok=True); p.write_text(str(content), encoding="utf-8"); return _ok(path=str(p), bytes=len(str(content).encode("utf-8")))
    except Exception as exc: return _fail(str(exc), path=str(p))
def screenshot(params=None):
    require("SCREEN_CAPTURE", params)
    try:
        from PIL import ImageGrab
        from io import BytesIO
        image = ImageGrab.grab(all_screens=True); buf = BytesIO(); image.save(buf, format="PNG"); return _ok(data=base64.b64encode(buf.getvalue()).decode("ascii"), mimeType="image/png", width=image.width, height=image.height)
    except Exception as exc: return _fail(str(exc))
def web_get(url, params=None):
    require("WEB_READ", params); parsed = urllib.parse.urlparse(str(url))
    if parsed.scheme not in {"http", "https"} or not parsed.netloc: return _fail("only http(s) URLs are supported")
    try:
        request = urllib.request.Request(str(url), headers={"User-Agent": "NOVA-Genesis/1.0"})
        with urllib.request.urlopen(request, timeout=15) as response: body = response.read(2 * 1024 * 1024).decode("utf-8", errors="replace")
        return _ok(url=str(url), status=200, text=body)
    except Exception as exc: return _fail(str(exc), url=str(url))
def sleep(seconds, params=None): value = max(0.0, min(float(seconds), 30.0)); time.sleep(value); return _ok(seconds=value)

__all__ = ["ToolCapabilityError", "system_info", "active_window", "window_list", "process_list", "launch", "close_process", "window_focus", "mouse_move", "mouse_click", "mouse_scroll", "type_text", "key_press", "clipboard_get", "clipboard_set", "file_read", "file_write", "screenshot", "web_get", "sleep", "require"]
