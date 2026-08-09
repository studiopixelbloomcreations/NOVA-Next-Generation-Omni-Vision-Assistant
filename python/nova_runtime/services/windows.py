"""Windows desktop service.

Real Win32/OS introspection: the currently focused window, the visible window
list, and a process snapshot with CPU/memory. Uses ctypes against user32 and
PowerShell for structured process data. No process control operations are
exposed — this service is read-only by design.
"""
import ctypes
import ctypes.wintypes as wt
import json
import subprocess
import sys
from typing import Any, Dict, List


def _user32() -> Any:
    return ctypes.windll.user32 if sys.platform == "win32" else None


def active_window() -> Dict[str, Any]:
    """Currently focused window (app, title, pid, process name)."""
    if not _user32():
        return {"available": False, "error": "Win32 API only available on Windows"}
    try:
        user32 = _user32()
        hwnd = user32.GetForegroundWindow()
        if not hwnd:
            return {"available": False, "error": "no foreground window"}
        length = user32.GetWindowTextLengthW(hwnd)
        buf = ctypes.create_unicode_buffer(length + 1)
        user32.GetWindowTextW(hwnd, buf, length + 1)
        pid = wt.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        proc = _process_name(int(pid.value))
        return {
            "available": True,
            "handle": int(hwnd),
            "title": buf.value,
            "pid": int(pid.value),
            "process": proc,
        }
    except Exception as exc:  # noqa: BLE001
        return {"available": False, "error": f"{type(exc).__name__}: {exc}"}


def _process_name(pid: int) -> str:
    try:
        result = subprocess.run(
            [
                "powershell",
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                f"(Get-Process -Id {pid} -ErrorAction SilentlyContinue).ProcessName",
            ],
            capture_output=True,
            text=True,
            timeout=8,
        )
        return result.stdout.strip() or "unknown"
    except Exception:
        return "unknown"


def _enum_windows() -> List[Dict[str, Any]]:
    user32 = _user32()
    if not user32:
        return []

    results: List[Dict[str, Any]] = []

    def _callback(hwnd: int, _lparam: Any) -> bool:
        if not user32.IsWindowVisible(hwnd):
            return True
        length = user32.GetWindowTextLengthW(hwnd)
        if length == 0:
            return True
        buf = ctypes.create_unicode_buffer(length + 1)
        user32.GetWindowTextW(hwnd, buf, length + 1)
        pid = wt.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        results.append(
            {
                "title": buf.value,
                "pid": int(pid.value),
                "handle": int(hwnd),
            }
        )
        return True

    WNDENUMPROC = ctypes.WINFUNCTYPE(ctypes.c_bool, wt.HWND, wt.LPARAM)
    user32.EnumWindows(WNDENUMPROC(_callback), 0)
    return results


def _pid_name_map(pids: List[int]) -> Dict[int, str]:
    """One PowerShell call resolves all PIDs to process names (no N+1)."""
    if not pids:
        return {}
    try:
        ids = ",".join(str(p) for p in pids)
        result = subprocess.run(
            [
                "powershell",
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                f"Get-Process -Id ({ids}) -ErrorAction SilentlyContinue | "
                "Select-Object Id,ProcessName | ConvertTo-Json -Compress",
            ],
            capture_output=True,
            text=True,
            timeout=15,
        )
        raw = result.stdout.strip()
        if not raw:
            return {}
        data = json.loads(raw)
        rows = data if isinstance(data, list) else [data]
        mapping: Dict[int, str] = {}
        for row in rows:
            pid = int(row.get("Id") or 0)
            name = str(row.get("ProcessName") or "unknown")
            if pid:
                mapping[pid] = name
        return mapping
    except Exception:
        return {}


def window_list(limit: int = 50) -> Dict[str, Any]:
    """Visible top-level windows with titles (capped)."""
    try:
        windows = _enum_windows()
        capped = windows[: max(1, min(int(limit), 100))]
        # Batch-resolve process names in a single call.
        names = _pid_name_map([w["pid"] for w in capped])
        for win in capped:
            win["process"] = names.get(win["pid"], "unknown")
        return {"available": True, "windows": capped, "count": len(capped)}
    except Exception as exc:  # noqa: BLE001
        return {"available": False, "error": f"{type(exc).__name__}: {exc}"}


def process_list(limit: int = 30) -> Dict[str, Any]:
    """Running processes with name, pid, CPU-seconds, and working-set bytes."""
    try:
        capped = max(1, min(int(limit), 200))
        result = subprocess.run(
            [
                "powershell",
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "Get-Process | Sort-Object CPU -Descending | "
                f"Select-Object -First {capped} Id,ProcessName,CPU,WorkingSet64,Path | "
                "ConvertTo-Json -Compress",
            ],
            capture_output=True,
            text=True,
            timeout=25,
        )
        raw = result.stdout.strip()
        rows: List[Dict[str, Any]] = []
        if raw:
            data = json.loads(raw)
            items = data if isinstance(data, list) else [data]
            for item in items:
                rows.append(
                    {
                        "name": str(item.get("ProcessName") or "unknown"),
                        "pid": int(item.get("Id") or 0),
                        "cpuSeconds": round(float(item.get("CPU") or 0), 2),
                        "memoryBytes": int(item.get("WorkingSet64") or 0),
                        "path": str(item.get("Path") or ""),
                    }
                )
        return {"available": True, "processes": rows, "count": len(rows)}
    except Exception as exc:  # noqa: BLE001
        return {"available": False, "error": f"{type(exc).__name__}: {exc}"}


def system_uptime_seconds() -> int:
    """Boot time of the host (seconds), via GetTickCount64 when available."""
    try:
        if sys.platform == "win32":
            k32 = ctypes.windll.kernel32
            return int(k32.GetTickCount64() / 1000)
    except Exception:
        pass
    try:
        import time

        with open("/proc/uptime", "r", encoding="utf-8") as fh:
            return int(float(fh.read().split()[0]))
    except Exception:
        return 0


# --------------------------------------------------------------------------
# Window management (focus / minimize / maximize / restore / move / resize)
# --------------------------------------------------------------------------

_SW_MINIMIZE = 6
_SW_MAXIMIZE = 3
_SW_RESTORE = 9
_SW_SHOW = 5


def _find_window(match: str | None = None) -> int | None:
    """First visible top-level window whose title contains `match` (case-insensitive).

    When match is empty/None returns the current foreground window handle.
    Returns None when no window matches.
    """
    user32 = _user32()
    if not user32:
        return None
    if not match:
        hwnd = user32.GetForegroundWindow()
        return int(hwnd) if hwnd else None
    needle = str(match).strip().lower()
    if not needle:
        hwnd = user32.GetForegroundWindow()
        return int(hwnd) if hwnd else None
    # Reuse the batch enumerator instead of duplicating the callback.
    for win in _enum_windows():
        if needle in str(win.get("title", "")).lower():
            return int(win["handle"])
    return None


def _window_state(hwnd: int) -> Dict[str, Any]:
    user32 = _user32()
    if not hwnd:
        return {"available": False, "error": "window not found"}
    length = user32.GetWindowTextLengthW(hwnd)
    buf = ctypes.create_unicode_buffer(length + 1)
    user32.GetWindowTextW(hwnd, buf, length + 1)
    rect = wt.RECT()
    user32.GetWindowRect(hwnd, ctypes.byref(rect))
    minimized = bool(user32.IsIconic(hwnd))
    maximized = bool(user32.IsZoomed(hwnd))
    pid = wt.DWORD()
    user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
    return {
        "available": True,
        "handle": int(hwnd),
        "title": buf.value,
        "pid": int(pid.value),
        "minimized": minimized,
        "maximized": maximized,
        "bounds": {
            "x": int(rect.left),
            "y": int(rect.top),
            "width": int(rect.right - rect.left),
            "height": int(rect.bottom - rect.top),
        },
    }


def window_focus(title: str = "") -> Dict[str, Any]:
    """Bring the matching window to the foreground (best-effort)."""
    user32 = _user32()
    if not user32:
        return {"available": False, "error": "Win32 API only available on Windows"}
    hwnd = _find_window(title)
    if hwnd is None:
        return {"available": False, "error": f"no visible window matching '{title}'"}
    # SetForegroundWindow is restricted by Windows; first simulate an input
    # event so the foreground lock is relinquished (standard practice).
    user32.keybd_event(0, 0, 0, 0)
    user32.SetForegroundWindow(hwnd)
    user32.BringWindowToTop(hwnd)
    user32.ShowWindow(hwnd, _SW_SHOW)
    state = _window_state(hwnd)
    state["focused"] = bool(user32.GetForegroundWindow() == hwnd)
    return state


def window_minimize(title: str = "") -> Dict[str, Any]:
    hwnd = _find_window(title)
    if hwnd is None:
        return {"available": False, "error": f"no visible window matching '{title}'"}
    _user32().ShowWindow(hwnd, _SW_MINIMIZE)
    return _window_state(hwnd)


def window_maximize(title: str = "") -> Dict[str, Any]:
    hwnd = _find_window(title)
    if hwnd is None:
        return {"available": False, "error": f"no visible window matching '{title}'"}
    _user32().ShowWindow(hwnd, _SW_MAXIMIZE)
    return _window_state(hwnd)


def window_restore(title: str = "") -> Dict[str, Any]:
    hwnd = _find_window(title)
    if hwnd is None:
        return {"available": False, "error": f"no visible window matching '{title}'"}
    _user32().ShowWindow(hwnd, _SW_RESTORE)
    return _window_state(hwnd)


def window_move(title: str, x: int, y: int, width: int | None = None, height: int | None = None) -> Dict[str, Any]:
    """Move (and optionally resize) a window. Width/height fall back to current."""
    hwnd = _find_window(title)
    if hwnd is None:
        return {"available": False, "error": f"no visible window matching '{title}'"}
    state = _window_state(hwnd)
    bounds = state.get("bounds", {})
    w = int(width) if width is not None else int(bounds.get("width", 800))
    h = int(height) if height is not None else int(bounds.get("height", 600))
    _user32().SetWindowPos(
        hwnd,
        0,
        int(x),
        int(y),
        max(1, w),
        max(1, h),
        0x0040,  # SWP_NOZORDER
    )
    return _window_state(hwnd)
