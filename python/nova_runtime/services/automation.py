"""Desktop automation service.

Launching applications/URLs uses the OS shell and works with the standard
library. Mouse and keyboard control use the Win32 SendInput API via ctypes —
no third-party dependency — so real PC control works out of the box on
Windows. Screenshots prefer pyautogui but fall back to a PowerShell
System.Drawing capture so screen capture also works without optional deps.

Every action is deliberately granular (move / click / type / hotkey). There is
no generic "run any shell command" primitive.
"""
import ctypes
import subprocess
import sys
import time
from typing import Any, Dict, List

# ---------------------------------------------------------------------------
# Capability availability
# ---------------------------------------------------------------------------


def availability() -> Dict[str, bool]:
    mods: Dict[str, bool] = {}
    try:
        import pyautogui  # noqa: F401

        mods["pyautogui"] = True
    except Exception:
        mods["pyautogui"] = False
    mods["win32_input"] = sys.platform == "win32"
    mods["win32_screenshot"] = sys.platform == "win32"
    return mods


def _require_win32() -> None:
    if sys.platform != "win32":
        raise RuntimeError("Win32 input control is only available on Windows")


# ---------------------------------------------------------------------------
# Applications / URLs
# ---------------------------------------------------------------------------


def launch(target: str) -> Dict[str, Any]:
    if not target or not isinstance(target, str):
        raise ValueError("target required")
    if sys.platform == "win32":
        # startfile returns immediately; preferred for documents/URLs/executables.
        try:
            import os

            os.startfile(target)  # type: ignore[attr-defined]
            return {"launched": target, "method": "startfile"}
        except (OSError, AttributeError):
            pass
        result = subprocess.run(
            ["cmd", "/c", "start", "", target],
            capture_output=True,
            timeout=15,
            shell=False,
        )
        if result.returncode != 0:
            raise RuntimeError(result.stderr.decode("utf-8", errors="replace").strip() or "launch failed")
        return {"launched": target, "method": "cmd-start"}
    if sys.platform == "darwin":
        subprocess.Popen(["open", target])
    else:
        subprocess.Popen(["xdg-open", target])
    return {"launched": target, "method": "shell"}


# ---------------------------------------------------------------------------
# Win32 input primitives (SendInput — no third-party dependency)
# ---------------------------------------------------------------------------


def _input_struct():
    from ctypes import Structure, Union, c_long, c_ulong, c_ushort, c_byte, c_int

    class KEYBDINPUT(Structure):
        _fields_ = [
            ("wVk", c_ushort),
            ("wScan", c_ushort),
            ("dwFlags", c_ulong),
            ("time", c_ulong),
            # dwExtraInfo is ULONG_PTR — c_size_t on both 32/64-bit.
            ("dwExtraInfo", ctypes.c_size_t),
        ]

    class MOUSEINPUT(Structure):
        _fields_ = [
            ("dx", c_long),
            ("dy", c_long),
            ("mouseData", c_ulong),
            ("dwFlags", c_ulong),
            ("time", c_ulong),
            # dwExtraInfo is ULONG_PTR — c_size_t on both 32/64-bit.
            ("dwExtraInfo", ctypes.c_size_t),
        ]

    class INPUT_UNION(Union):
        _fields_ = [("mi", MOUSEINPUT), ("ki", KEYBDINPUT)]

    class INPUT(Structure):
        _fields_ = [("type", c_ulong), ("union", INPUT_UNION)]

    return INPUT, MOUSEINPUT, KEYBDINPUT


# SendInput flag constants
_MOUSEEVENTF_MOVE = 0x0001
_MOUSEEVENTF_LEFTDOWN = 0x0002
_MOUSEEVENTF_LEFTUP = 0x0004
_MOUSEEVENTF_RIGHTDOWN = 0x0008
_MOUSEEVENTF_RIGHTUP = 0x0010
_MOUSEEVENTF_MIDDLEDOWN = 0x0020
_MOUSEEVENTF_MIDDLEUP = 0x0040
_MOUSEEVENTF_WHEEL = 0x0800
_MOUSEEVENTF_ABSOLUTE = 0x8000

_KEYEVENTF_KEYUP = 0x0002
_KEYEVENTF_SCANCODE = 0x0008
_INPUT_MOUSE = 0
_INPUT_KEYBOARD = 1

_SM_CXSCREEN = 0
_SM_CYSCREEN = 1


def _screen_size() -> tuple:
    user32 = ctypes.windll.user32
    return user32.GetSystemMetrics(_SM_CXSCREEN), user32.GetSystemMetrics(_SM_CYSCREEN)


def _send(inputs) -> None:
    """Sends input events through SendInput.

    `inputs` is a list of INPUT instances. ctypes requires a contiguous array
    of structures (not a Python list) for the lpInputs pointer, so the list is
    copied into an (INPUT * n) array first.
    """
    if not inputs:
        return
    n = len(inputs)
    INPUT = type(inputs[0])
    Array = INPUT * n
    arr = Array()
    for i, inp in enumerate(inputs):
        arr[i] = inp
    sent = ctypes.windll.user32.SendInput(n, ctypes.cast(arr, ctypes.POINTER(INPUT)), ctypes.sizeof(INPUT))
    if sent != n:
        raise RuntimeError(f"SendInput delivered {sent}/{n} input events")


def mouse_move(x: int, y: int) -> Dict[str, Any]:
    """Absolute move of the mouse cursor to screen coordinates."""
    _require_win32()
    x, y = int(x), int(y)
    w, h = _screen_size()
    if not (0 <= x <= w and 0 <= y <= h):
        raise ValueError(f"coordinates ({x},{y}) outside screen {w}x{h}")
    INPUT, MI, _KI = _input_struct()
    abs_x = int(x * 65535 / max(1, w - 1))
    abs_y = int(y * 65535 / max(1, h - 1))
    inp = INPUT()
    inp.type = _INPUT_MOUSE
    inp.union.mi = MI(dx=abs_x, dy=abs_y, mouseData=0, dwFlags=_MOUSEEVENTF_MOVE | _MOUSEEVENTF_ABSOLUTE, time=0, dwExtraInfo=0)
    _send([inp])
    return {"x": x, "y": y}


def mouse_click(x: int | None = None, y: int | None = None, button: str = "left", clicks: int = 1) -> Dict[str, Any]:
    """Click at coordinates (or current cursor position). Supports left/right/middle."""
    _require_win32()
    if x is not None and y is not None:
        mouse_move(int(x), int(y))
        time.sleep(0.03)
    down_flag = {
        "left": _MOUSEEVENTF_LEFTDOWN,
        "right": _MOUSEEVENTF_RIGHTDOWN,
        "middle": _MOUSEEVENTF_MIDDLEDOWN,
    }.get(str(button).lower())
    if down_flag is None:
        raise ValueError("button must be left, right or middle")
    up_flag = {
        "left": _MOUSEEVENTF_LEFTUP,
        "right": _MOUSEEVENTF_RIGHTUP,
        "middle": _MOUSEEVENTF_MIDDLEUP,
    }[str(button).lower()]
    INPUT, MI, _KI = _input_struct()
    n = max(1, min(int(clicks), 20))
    inputs: list = []
    for _ in range(n):
        d = INPUT()
        d.type = _INPUT_MOUSE
        d.union.mi = MI(0, 0, 0, down_flag, 0, None)
        inputs.append(d)
        u = INPUT()
        u.type = _INPUT_MOUSE
        u.union.mi = MI(0, 0, 0, up_flag, 0, None)
        inputs.append(u)
    _send(inputs)
    return {"x": x, "y": y, "button": button, "clicks": n}


def mouse_double_click(x: int | None = None, y: int | None = None) -> Dict[str, Any]:
    return mouse_click(x, y, "left", clicks=2)


def mouse_drag(x1: int, y1: int, x2: int, y2: int, duration: float = 0.3) -> Dict[str, Any]:
    """Press the left button at (x1,y1), move to (x2,y2) over duration, release."""
    _require_win32()
    mouse_move(int(x1), int(y1))
    time.sleep(0.03)
    INPUT, MI, _KI = _input_struct()
    d = INPUT()
    d.type = _INPUT_MOUSE
    d.union.mi = MI(0, 0, 0, _MOUSEEVENTF_LEFTDOWN, 0, None)
    _send([d])
    steps = max(1, int(duration / 0.02))
    for i in range(1, steps + 1):
        t = i / steps
        mx = int(x1 + (x2 - x1) * t)
        my = int(y1 + (y2 - y1) * t)
        mouse_move(mx, my)
        time.sleep(0.02)
    u = INPUT()
    u.type = _INPUT_MOUSE
    u.union.mi = MI(0, 0, 0, _MOUSEEVENTF_LEFTUP, 0, None)
    _send([u])
    return {"from": [int(x1), int(y1)], "to": [int(x2), int(y2)]}


def mouse_scroll(clicks: int) -> Dict[str, Any]:
    """Vertical wheel scroll. Positive = up, negative = down (120 per notch)."""
    _require_win32()
    delta = int(120 * max(-50, min(50, int(clicks))))
    INPUT, MI, _KI = _input_struct()
    inp = INPUT()
    inp.type = _INPUT_MOUSE
    inp.union.mi = MI(0, 0, delta, _MOUSEEVENTF_WHEEL, 0, None)
    _send([inp])
    return {"notches": int(clicks)}


# Simple virtual-key map for common keys used by keyboard_press / hotkeys.
_KEYS: Dict[str, int] = {
    "enter": 0x0D, "return": 0x0D, "tab": 0x09, "space": 0x20,
    "esc": 0x1B, "escape": 0x1B, "backspace": 0x08,
    "delete": 0x2E, "del": 0x2E, "insert": 0x2D,
    "home": 0x24, "end": 0x23, "pageup": 0x21, "pagedown": 0x22,
    "up": 0x26, "down": 0x28, "left": 0x25, "right": 0x27,
    "ctrl": 0x11, "control": 0x11, "shift": 0x10, "alt": 0x12,
    "win": 0x5B, "lwin": 0x5B, "rwin": 0x5C,
    "capslock": 0x14, "f1": 0x70, "f2": 0x71, "f3": 0x72, "f4": 0x73,
    "f5": 0x74, "f6": 0x75, "f7": 0x76, "f8": 0x77, "f9": 0x78,
    "f10": 0x79, "f11": 0x7A, "f12": 0x7B,
    "a": 0x41, "b": 0x42, "c": 0x43, "d": 0x44, "e": 0x45, "f": 0x46,
    "g": 0x47, "h": 0x48, "i": 0x49, "j": 0x4A, "k": 0x4B, "l": 0x4C,
    "m": 0x4D, "n": 0x4E, "o": 0x4F, "p": 0x50, "q": 0x51, "r": 0x52,
    "s": 0x53, "t": 0x54, "u": 0x55, "v": 0x56, "w": 0x57, "x": 0x58,
    "y": 0x59, "z": 0x5A,
    "0": 0x30, "1": 0x31, "2": 0x32, "3": 0x33, "4": 0x34,
    "5": 0x35, "6": 0x36, "7": 0x37, "8": 0x38, "9": 0x39,
}


def _vk(key: str) -> int:
    k = str(key).strip().lower()
    if k in _KEYS:
        return _KEYS[k]
    if len(k) == 1 and k.isalnum():
        return ord(k.upper())
    raise ValueError(f"unsupported key: {key}")


def _press_vk(vk: int) -> None:
    INPUT, _MI, KI = _input_struct()
    d = INPUT()
    d.type = _INPUT_KEYBOARD
    d.union.ki = KI(wVk=vk, wScan=0, dwFlags=0, time=0, dwExtraInfo=0)
    u = INPUT()
    u.type = _INPUT_KEYBOARD
    u.union.ki = KI(wVk=vk, wScan=0, dwFlags=_KEYEVENTF_KEYUP, time=0, dwExtraInfo=0)
    _send([d, u])


def keyboard_press(key: str, repeat: int = 1) -> Dict[str, Any]:
    """Press (and release) a single key, optionally repeated."""
    _require_win32()
    vk = _vk(key)
    n = max(1, min(int(repeat), 100))
    for _ in range(n):
        _press_vk(vk)
    return {"key": key, "repeat": n}


def keyboard_hotkey(combo: str) -> Dict[str, Any]:
    """Press a key chord, e.g. \"ctrl+shift+esc\" or \"ctrl+c\". Keys pressed in
    order and released in reverse; modifiers held across the chord."""
    _require_win32()
    keys = [p.strip().lower() for p in str(combo).split("+") if p.strip()]
    if not keys:
        raise ValueError("hotkey combo required")
    vks = [_vk(k) for k in keys]
    INPUT, _MI, KI = _input_struct()
    downs: list = []
    for vk in vks:
        d = INPUT()
        d.type = _INPUT_KEYBOARD
        d.union.ki = KI(wVk=vk, wScan=0, dwFlags=0, time=0, dwExtraInfo=0)
        downs.append(d)
    ups: list = []
    for vk in reversed(vks):
        u = INPUT()
        u.type = _INPUT_KEYBOARD
        u.union.ki = KI(wVk=vk, wScan=0, dwFlags=_KEYEVENTF_KEYUP, time=0, dwExtraInfo=0)
        ups.append(u)
    _send(downs)
    _send(ups)
    return {"combo": combo}


# Map of characters to (vk, shift) for type_text — ASCII printable only.
_CHAR_VK: Dict[str, int] = {
    " ": 0x20, "!": 0x31, "\"": 0xDE, "#": 0x33, "$": 0x34, "%": 0x35,
    "&": 0x37, "'": 0xDE, "(": 0x39, ")": 0x30, "*": 0x38, "+": 0xBB,
    ",": 0xBC, "-": 0xBD, ".": 0xBE, "/": 0xBF, ":": 0xBA, ";": 0xBA,
    "<": 0xBC, "=": 0xBB, ">": 0xBE, "?": 0xBF, "@": 0x32,
    "[": 0xDB, "\\": 0xDC, "]": 0xDD, "^": 0xDE, "_": 0xBD, "`": 0xC0,
    "{": 0xDB, "|": 0xDC, "}": 0xDD, "~": 0xC0,
}


# Characters that require the shift modifier on a US keyboard layout.
_SHIFTED = set("~!@#$%^&*()_+{}|:\"<>?")


def _type_char(ch: str) -> None:
    INPUT, _MI, KI = _input_struct()
    shift = ch.isupper() or ch in _SHIFTED
    lower = ch.lower()
    vk = _CHAR_VK.get(lower)
    if vk is None:
        vk = ord(ch.upper())

    def _evt(code: int, up: bool = False, is_shift: bool = False) -> INPUT:
        inp = INPUT()
        inp.type = _INPUT_KEYBOARD
        f = _KEYEVENTF_KEYUP if up else 0
        inp.union.ki = KI(
            wVk=0x10 if is_shift else code,
            wScan=0,
            dwFlags=f,
            time=0,
            dwExtraInfo=0,
        )
        return inp

    if shift:
        _send([_evt(0x10)])
        _send([_evt(vk)])
        _send([_evt(0x10, up=True)])
    else:
        _send([_evt(vk)])
        _send([_evt(vk, up=True)])


def type_text(text: str) -> Dict[str, Any]:
    """Types text into the focused window (Win32 SendInput, ASCII printable)."""
    _require_win32()
    s = str(text)
    # Non-printable characters are best sent via the key map; refuse control chars.
    for ch in s:
        if ord(ch) < 32 and ch not in "\n\t":
            raise ValueError(f"unsupported control character in text: {ord(ch)}")
        if ch == "\n":
            _press_vk(_vk("enter"))
            continue
        if ch == "\t":
            _press_vk(_vk("tab"))
            continue
        _type_char(ch)
    return {"typed": len(s)}


# ---------------------------------------------------------------------------
# Screenshot (pyautogui preferred; PowerShell System.Drawing fallback)
# ---------------------------------------------------------------------------


def _ps_screenshot() -> Dict[str, Any]:
    """Full-screen PNG via PowerShell System.Drawing (no optional deps)."""
    script = (
        "Add-Type -AssemblyName System.Drawing; "
        "Add-Type -AssemblyName System.Windows.Forms; "
        "$b = [System.Windows.Forms.SystemInformation]::VirtualScreen; "
        "$bmp = New-Object System.Drawing.Bitmap($b.Width, $b.Height); "
        "$g = [System.Drawing.Graphics]::FromImage($bmp); "
        "$g.CopyFromScreen($b.X, $b.Y, 0, 0, $bmp.Size); "
        "$ms = New-Object System.IO.MemoryStream; "
        "$bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png); "
        "$bytes = $ms.ToArray(); "
        "[Convert]::ToBase64String($bytes)"
    )
    result = subprocess.run(
        ["powershell", "-NoProfile", "-NonInteractive", "-Command", script],
        capture_output=True,
        text=True,
        timeout=30,
    )
    b64 = result.stdout.strip()
    if not b64 or len(b64) < 100:
        raise RuntimeError(result.stderr.strip()[:200] or "PowerShell screenshot failed")
    import base64
    data = base64.b64decode(b64)
    # Decode dimensions from the PNG header.
    width = int.from_bytes(data[16:20], "big")
    height = int.from_bytes(data[20:24], "big")
    return {"width": width, "height": height, "mimeType": "image/png", "base64": b64}


def screenshot(monitor: int = 0) -> Dict[str, Any]:
    mods = availability()
    if mods.get("pyautogui"):
        import pyautogui

        img = pyautogui.screenshot(allScreens=monitor != 0)
        import base64
        import io

        buf = io.BytesIO()
        img.save(buf, format="PNG")
        data = buf.getvalue()
        return {
            "width": img.width,
            "height": img.height,
            "mimeType": "image/png",
            "base64": base64.b64encode(data).decode("ascii"),
        }
    if sys.platform == "win32":
        return _ps_screenshot()
    raise RuntimeError("screenshot requires pyautogui or a Windows host")


def screenshot_region(x: int = 0, y: int = 0, width: int = 800, height: int = 600) -> Dict[str, Any]:
    """Capture a specific screen region as PNG (pyautogui preferred)."""
    w = max(1, min(int(width), 10000))
    h = max(1, min(int(height), 10000))
    if availability().get("pyautogui"):
        import pyautogui
        import base64
        import io

        img = pyautogui.screenshot(region=(int(x), int(y), w, h))
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        data = buf.getvalue()
        return {
            "width": img.width,
            "height": img.height,
            "mimeType": "image/png",
            "base64": base64.b64encode(data).decode("ascii"),
            "region": {"x": int(x), "y": int(y), "width": w, "height": h},
        }
    # Fallback: full screenshot + PowerShell crop via System.Drawing.
    full = _ps_screenshot()
    import base64
    import io

    # Crop in PowerShell to honor the region.
    script = (
        f"Add-Type -AssemblyName System.Drawing; "
        f"$src = [System.Drawing.Image]::FromStream([System.IO.MemoryStream][Convert]::FromBase64String('{full['base64']}')); "
        f"$bmp = New-Object System.Drawing.Bitmap({w}, {h}); "
        f"$g = [System.Drawing.Graphics]::FromImage($bmp); "
        f"$g.DrawImage($src, (New-Object System.Drawing.Rectangle(0,0,{w},{h})), "
        f"(New-Object System.Drawing.Rectangle({int(x)},{int(y)},{w},{h})), [System.Drawing.GraphicsUnit]::Pixel); "
        f"$ms = New-Object System.IO.MemoryStream; "
        f"$bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png); "
        f"[Convert]::ToBase64String($ms.ToArray())"
    )
    result = subprocess.run(
        ["powershell", "-NoProfile", "-NonInteractive", "-Command", script],
        capture_output=True,
        text=True,
        timeout=30,
    )
    b64 = result.stdout.strip()
    if not b64 or len(b64) < 100:
        raise RuntimeError(result.stderr.strip()[:200] or "PowerShell region capture failed")
    data = base64.b64decode(b64)
    return {
        "width": int.from_bytes(data[16:20], "big"),
        "height": int.from_bytes(data[20:24], "big"),
        "mimeType": "image/png",
        "base64": b64,
        "region": {"x": int(x), "y": int(y), "width": w, "height": h},
    }


def screen_ocr() -> Dict[str, Any]:
    """OCR the current screen: screenshot then extract text when tesseract exists."""
    shot = screenshot(0)
    import base64
    import io

    try:
        from PIL import Image
        import pytesseract
    except Exception as exc:
        return {"available": False, "error": f"screen_ocr requires pillow + pytesseract ({exc})"}
    try:
        img = Image.open(io.BytesIO(base64.b64decode(shot["base64"])))
        text = pytesseract.image_to_string(img)
        return {"available": True, "text": text, "width": shot["width"], "height": shot["height"]}
    except Exception as exc:  # noqa: BLE001
        return {"available": False, "error": f"screen_ocr failed: {exc}"}
