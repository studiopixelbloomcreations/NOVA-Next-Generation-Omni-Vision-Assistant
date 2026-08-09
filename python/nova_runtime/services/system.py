"""System introspection service.

Pure-stdlib reporting of the host the worker is running on: platform, CPU,
memory, disks, and a capped process list. Nothing here mutates the system.
"""
import json
import os
import platform
import shutil
import subprocess
import sys
from typing import Any, Dict, List


def _cpu_info() -> Dict[str, Any]:
    try:
        count = os.cpu_count() or 0
    except Exception:
        count = 0
    model = platform.processor() or "unknown"
    return {"cores": count, "model": model}


def _memory_info() -> Dict[str, Any]:
    try:
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
            return {
                "loadPercent": int(stat.dwMemoryLoad),
                "totalBytes": int(stat.ullTotalPhys),
                "availableBytes": int(stat.ullAvailPhys),
            }
    except Exception:
        pass
    return {"loadPercent": None, "totalBytes": None, "availableBytes": None}


def _disk_info() -> List[Dict[str, Any]]:
    disks: List[Dict[str, Any]] = []
    try:
        if sys.platform == "win32":
            import string

            for letter in string.ascii_uppercase:
                root = f"{letter}:\\"
                if os.path.exists(root):
                    usage = shutil.disk_usage(root)
                    disks.append(
                        {
                            "mount": root,
                            "totalBytes": usage.total,
                            "freeBytes": usage.free,
                        }
                    )
        else:
            usage = shutil.disk_usage("/")
            disks.append({"mount": "/", "totalBytes": usage.total, "freeBytes": usage.free})
    except Exception:
        pass
    return disks


def _processes(limit: int = 25) -> List[Dict[str, Any]]:
    """A capped snapshot of running processes (name + pid)."""
    procs: List[Dict[str, Any]] = []
    try:
        if sys.platform == "win32":
            result = subprocess.run(
                ["powershell", "-NoProfile", "-NonInteractive", "-Command",
                 "Get-Process | Select-Object -First {n} -Property Id,ProcessName | ConvertTo-Json -Compress".format(n=limit)],
                capture_output=True,
                text=True,
                timeout=10,
            )
            raw = result.stdout.strip()
            if raw:
                data = json.loads(raw)
                rows = data if isinstance(data, list) else [data]
                for row in rows:
                    name = row.get("ProcessName") or row.get("Name") or "unknown"
                    procs.append({"name": str(name), "pid": int(row.get("Id") or 0)})
        else:
            result = subprocess.run(
                ["ps", "-eo", "pid,comm", "--sort=-%cpu"],
                capture_output=True,
                text=True,
                timeout=10,
            )
            for line in result.stdout.strip().splitlines()[1 : limit + 1]:
                parts = line.split(None, 1)
                if len(parts) == 2:
                    procs.append({"name": parts[1], "pid": int(parts[0])})
    except Exception:
        pass
    return procs[:limit]


def _gpu_info() -> List[Dict[str, Any]]:
    try:
        result = subprocess.run(
            ["powershell", "-NoProfile", "-NonInteractive", "-Command",
             "Get-CimInstance Win32_VideoController | Select-Object Name,AdapterRAM,DriverVersion,Status | ConvertTo-Json -Compress"],
            capture_output=True,
            text=True,
            timeout=20,
        )
        raw = result.stdout.strip()
        if not raw:
            return []
        data = json.loads(raw)
        rows = data if isinstance(data, list) else [data]
        return [
            {
                "name": str(r.get("Name") or "unknown"),
                "driverVersion": str(r.get("DriverVersion") or ""),
                "status": str(r.get("Status") or ""),
            }
            for r in rows
        ]
    except Exception:
        return []


def _uptime_seconds() -> int:
    try:
        from nova_runtime.services.windows import system_uptime_seconds

        return system_uptime_seconds()
    except Exception:
        return 0


def system_info() -> Dict[str, Any]:
    return {
        "platform": sys.platform,
        "platformDetail": platform.platform(),
        "release": platform.release(),
        "machine": platform.machine(),
        "hostname": platform.node(),
        "python": platform.python_version(),
        "cpu": _cpu_info(),
        "memory": _memory_info(),
        "disks": _disk_info(),
        "gpu": _gpu_info(),
        "uptimeSeconds": _uptime_seconds(),
    }


def top_processes(limit: int = 25) -> Dict[str, Any]:
    capped = max(1, min(int(limit), 100))
    return {"processes": _processes(capped)}
