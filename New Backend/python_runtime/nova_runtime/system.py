"""Host/OS introspection service (stdlib only, real data)."""
from __future__ import annotations

import json
import os
import platform
import sys
from typing import Any, Dict, List


def _cpu_info() -> Dict[str, Any]:
    return {"cores": os.cpu_count() or 0, "model": platform.processor() or platform.machine()}


def _memory_info() -> Dict[str, Any]:
    try:
        if sys.platform == "win32":
            import ctypes

            class MEMORYSTATUSEX(ctypes.Structure):
                _fields_ = [
                    ("dwLength", ctypes.c_ulong),
                    ("dwMemoryLoad", ctypes.c_ulong),
                    ("ullTotalPhys", ctypes.c_ulonglong),
                    ("ullAvailPhys", ctypes.c_ulonglong),
                    ("ullTotalPageFile", ctypes.c_ulonglong),
                    ("ullAvailPageFile", ctypes.c_ulonglong),
                    ("ullTotalVirtual", ctypes.c_ulonglong),
                    ("ullAvailVirtual", ctypes.c_ulonglong),
                    ("ullAvailExtendedVirtual", ctypes.c_ulonglong),
                ]

            stat = MEMORYSTATUSEX()
            stat.dwLength = ctypes.sizeof(MEMORYSTATUSEX)
            if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(stat)):
                return {"loadPercent": int(stat.dwMemoryLoad), "totalBytes": int(stat.ullTotalPhys), "availableBytes": int(stat.ullAvailPhys)}
        elif sys.platform == "linux":
            with open("/proc/meminfo") as f:
                info = {}
                for line in f:
                    k, _, v = line.partition(":")
                    info[k.strip()] = int(v.strip().split()[0]) * 1024  # kB -> bytes
            total = info.get("MemTotal", 0)
            avail = info.get("MemAvailable", info.get("MemFree", 0))
            load = int((total - avail) / total * 100) if total else None
            return {"loadPercent": load, "totalBytes": total, "availableBytes": avail}
    except Exception:
        pass
    return {"loadPercent": None, "totalBytes": None, "availableBytes": None}


def system_info() -> Dict[str, Any]:
    mem = _memory_info()
    return {
        "os": platform.system(),
        "release": platform.release(),
        "version": platform.version(),
        "machine": platform.machine(),
        "hostname": platform.node(),
        "python": platform.python_version(),
        "cpu": _cpu_info(),
        "memory": mem,
    }


def top_processes(limit: int = 25) -> List[Dict[str, Any]]:
    procs: List[Dict[str, Any]] = []
    try:
        if sys.platform == "linux":
            for pid in os.listdir("/proc"):
                if not pid.isdigit():
                    continue
                try:
                    with open(f"/proc/{pid}/comm") as f:
                        name = f.read().strip()
                    procs.append({"pid": int(pid), "name": name})
                except Exception:
                    continue
        elif sys.platform == "win32":
            import subprocess

            out = subprocess.run(
                ["powershell", "-NoProfile", "-Command", "Get-Process | Select-Object -First 60 ProcessName,Id | ConvertTo-Json -Compress"],
                capture_output=True,
                text=True,
                timeout=10,
            )
            import json as _json

            data = _json.loads(out.stdout or "[]")
            arr = data if isinstance(data, list) else [data]
            for p in arr:
                if p and p.get("ProcessName"):
                    procs.append({"pid": int(p.get("Id", 0)), "name": str(p.get("ProcessName"))})
    except Exception:
        pass
    procs.sort(key=lambda p: -p["pid"])
    return procs[: max(1, min(limit, 200))]


def env_snapshot() -> Dict[str, Any]:
    return {
        "platform": sys.platform,
        "cwd": os.getcwd(),
        "home": os.path.expanduser("~"),
        "python_executable": sys.executable,
    }


if __name__ == "__main__":  # pragma: no cover
    import json as _j

    req = _j.load(sys.stdin)
    cmd = req.get("cmd", "info")
    if cmd == "processes":
        print(_j.dumps({"processes": top_processes(int(req.get("limit", 25)))}))
    else:
        print(_j.dumps(system_info()))
    sys.stdout.flush()
