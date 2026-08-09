"""Windows audio service.

Real device discovery and a local microphone diagnostic. Everything here talks
to the actual Windows audio stack:

* ``audio.devices``        — enumerate audio endpoints (real names/status).
* ``audio.microphone_info``— the default capture endpoint + input devices.
* ``audio.diagnostic``     — opens the default capture endpoint with WASAPI
                             (via ctypes, no third-party packages), records a
                             short sample, and reports non-zero frame counts and
                             RMS energy. The sample is analysed locally and
                             never leaves the process.

If the Core Audio COM calls fail (headless session / no endpoint), each
function degrades to PnP endpoint enumeration so NOVA still reports the real
hardware truth instead of fabricating a device.
"""
import base64
import ctypes
import ctypes.wintypes as wt
import json
import subprocess
import sys
from typing import Any, Dict, List

if sys.platform == "win32":
    try:
        from ctypes import COMError  # type: ignore[attr-defined]  # noqa: F401
    except ImportError:
        COMError = Exception  # type: ignore[misc]

# ---------------------------------------------------------------------------
# WASAPI COM definitions (subset needed for capture + RMS)
# ---------------------------------------------------------------------------


def _wasapi_available() -> bool:
    return sys.platform == "win32"


def _default_capture_device_id() -> str:
    """Best-effort default capture endpoint id.

    Tries the Windows Runtime API (MediaDevice.GetDefaultAudioCaptureId); on
    PowerShell 5.1 the WinRT overload can be unavailable, so this degrades to
    empty and the caller falls back to the first enumerated input device — the
    WASAPI diagnostic still records from the OS default either way.
    """
    try:
        result = subprocess.run(
            [
                "powershell",
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "Add-Type -AssemblyName System.Runtime.WindowsRuntime -ErrorAction SilentlyContinue; "
                "[Windows.Media.Devices.MediaDevice,Windows.Media.Devices,ContentType=WindowsRuntime] | Out-Null; "
                "[Windows.Media.Devices.MediaDevice]::GetDefaultAudioCaptureId()",
            ],
            capture_output=True,
            text=True,
            timeout=15,
        )
        line = result.stdout.strip()
        if line.startswith("{") and not line.startswith("Cannot"):
            return line
        err = result.stderr.strip() or result.stdout.strip()
        print(
            f"[audio] WinRT default-capture lookup unavailable ({err[:200] or 'no id'}); "
            "falling back to first PnP input — WASAPI still records the OS default",
            file=sys.stderr,
        )
        return ""
    except Exception as exc:  # noqa: BLE001 - diagnostic must never throw
        print(
            f"[audio] WinRT default-capture lookup failed ({exc}); "
            "falling back to first PnP input — WASAPI still records the OS default",
            file=sys.stderr,
        )
        return ""


def _pnp_audio_endpoints() -> List[Dict[str, Any]]:
    """Real audio endpoints via the Windows PnP provider (names + status)."""
    try:
        result = subprocess.run(
            [
                "powershell",
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "Get-PnpDevice -Class AudioEndpoint -ErrorAction SilentlyContinue | "
                "Select-Object FriendlyName,Status,InstanceId,Class | ConvertTo-Json -Compress",
            ],
            capture_output=True,
            text=True,
            timeout=20,
        )
        raw = result.stdout.strip()
        if not raw:
            return []
        data = json.loads(raw)
        rows = data if isinstance(data, list) else [data]
        endpoints: List[Dict[str, Any]] = []
        for row in rows:
            endpoints.append(
                {
                    "name": str(row.get("FriendlyName") or "Unknown endpoint"),
                    "status": str(row.get("Status") or "Unknown"),
                    "id": str(row.get("InstanceId") or ""),
                    "direction": (
                        "input"
                        if any(
                            k in (str(row.get("FriendlyName") or "")).lower()
                            for k in ("microphone", "mic", "array", "input")
                        )
                        else "output"
                    ),
                }
            )
        return endpoints
    except Exception:
        return []


def _wmic_input_devices() -> List[Dict[str, Any]]:
    """Classic sound devices (includes input hardware, name + status)."""
    try:
        result = subprocess.run(
            [
                "powershell",
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "Get-CimInstance Win32_SoundDevice | Select-Object Name,Status,DeviceID,Manufacturer | ConvertTo-Json -Compress",
            ],
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
                "name": str(r.get("Name") or "Unknown"),
                "status": str(r.get("Status") or "Unknown"),
                "id": str(r.get("DeviceID") or ""),
                "manufacturer": str(r.get("Manufacturer") or ""),
            }
            for r in rows
        ]
    except Exception:
        return []


def devices() -> Dict[str, Any]:
    """Real audio endpoint discovery (PnP), grouped by direction."""
    endpoints = _pnp_audio_endpoints()
    sound_cards = _wmic_input_devices()
    inputs = [e for e in endpoints if e["direction"] == "input"]
    outputs = [e for e in endpoints if e["direction"] != "input"]
    return {
        "available": bool(endpoints),
        "inputs": inputs,
        "outputs": outputs,
        "soundCards": sound_cards,
        "count": len(endpoints),
    }


def microphone_info() -> Dict[str, Any]:
    """Default capture endpoint + input device list."""
    d = devices()
    default_id = _default_capture_device_id()
    default_name: Any = None
    if default_id:
        # Match the WinRT default id against the PnP endpoint InstanceIds.
        for endpoint in d["inputs"]:
            if default_id.lower() in str(endpoint.get("id", "")).lower():
                default_name = endpoint.get("name")
                break
    if default_name is None and d["inputs"]:
        default_name = d["inputs"][0]["name"]
    return {
        "available": bool(d["inputs"]) or bool(d["soundCards"]),
        "defaultCapture": default_name,
        "defaultCaptureId": default_id or None,
        "inputs": d["inputs"],
        "soundCards": d["soundCards"],
        "message": (
            "Microphone available"
            if (d["inputs"] or d["soundCards"])
            else "No microphone input device detected on this system"
        ),
    }


def _wasapi_capture_rms(sample_ms: int = 500) -> Dict[str, Any]:
    """Record from the default capture endpoint via WASAPI and compute RMS.

    Pure ctypes implementation — no third-party audio package required. The
    recorded frames are analysed for energy and never sent anywhere. COM is
    initialized per call and uninitialized on exit so the long-lived worker
    never leaks Core Audio references.
    """
    if not _wasapi_available():
        return {"ok": False, "error": "WASAPI is only available on Windows"}

    def _capture() -> Dict[str, Any]:
        # pylint: disable=too-many-locals, too-many-statements
        import math
        import uuid as _uuid
        from ctypes import POINTER, Structure, byref, c_int, c_void_p, windll
        from ctypes.wintypes import DWORD, WORD
        from ctypes import c_ubyte, c_uint32, c_uint64, c_longlong, HRESULT, CFUNCTYPE

        # COM is initialized by the caller (wrapped with S_FALSE balancing);
        # this thread inherits the init on this thread of execution.
        CLSID_MMDEVICE = _uuid.UUID("{BCDE0395-E52F-467C-8E3D-C4579291692E}")
        IID_ENUM = _uuid.UUID("{A95664D2-9614-4F35-A746-DE8DB63617E6}")

        class IMMDeviceEnumerator(Structure):
            pass

        class IMMDevice(Structure):
            pass

        class IAudioClient(Structure):
            pass

        class IAudioCaptureClient(Structure):
            pass

        class WAVEFORMATEX(Structure):
            _fields_ = [
                ("wFormatTag", WORD),
                ("nChannels", WORD),
                ("nSamplesPerSec", DWORD),
                ("nAvgBytesPerSec", DWORD),
                ("nBlockAlign", WORD),
                ("wBitsPerSample", WORD),
                ("cbSize", WORD),
            ]

        def vtable_fn(iface_ptr: ctypes.c_void_p, slot: int, restype, argtypes):
            vtbl = ctypes.cast(iface_ptr, POINTER(POINTER(ctypes.c_void_p))).contents
            return ctypes.cast(vtbl[slot], ctypes.CFUNCTYPE(restype, *argtypes))

        pEnum = POINTER(IMMDeviceEnumerator)()
        hr = windll.ole32.CoCreateInstance(
            ctypes.cast(ctypes.c_char_p(CLSID_MMDEVICE.bytes_le), ctypes.c_void_p),
            None,
            1,  # CLSCTX_INPROC_SERVER
            ctypes.cast(ctypes.c_char_p(IID_ENUM.bytes_le), ctypes.c_void_p),
            byref(pEnum),
        )
        if hr < 0:
            return {"ok": False, "error": f"MMDeviceEnumerator failed (0x{hr & 0xFFFFFFFF:08x})"}
        enum_ptr = ctypes.cast(pEnum, ctypes.c_void_p)

        get_default = vtable_fn(
            enum_ptr, 4, HRESULT, [ctypes.c_void_p, c_int, c_int, POINTER(POINTER(IMMDevice))]
        )
        pDevice = POINTER(IMMDevice)()
        hr = get_default(enum_ptr, 1, 0, byref(pDevice))  # eCapture=1, eRole=0
        if hr < 0:
            return {"ok": False, "error": f"GetDefaultAudioEndpoint failed (0x{hr & 0xFFFFFFFF:08x})"}
        dev_ptr = ctypes.cast(pDevice, ctypes.c_void_p)

        IID_AUDIO_CLIENT = _uuid.UUID("{1CB9AD4C-DBFA-4C32-B178-C2F568A703B2}")
        activate = vtable_fn(
            dev_ptr,
            3,
            HRESULT,
            [ctypes.c_void_p, ctypes.c_void_p, DWORD, ctypes.c_void_p, POINTER(ctypes.c_void_p)],
        )
        pClient = ctypes.c_void_p()
        hr = activate(
            dev_ptr,
            ctypes.cast(ctypes.c_char_p(IID_AUDIO_CLIENT.bytes_le), ctypes.c_void_p),
            1,
            None,
            byref(pClient),
        )
        if hr < 0:
            return {"ok": False, "error": f"IAudioClient::Activate failed (0x{hr & 0xFFFFFFFF:08x})"}
        client_ptr = ctypes.cast(pClient, ctypes.c_void_p)

        get_mix = vtable_fn(client_ptr, 8, HRESULT, [ctypes.c_void_p, POINTER(POINTER(WAVEFORMATEX))])
        fmt = POINTER(WAVEFORMATEX)()
        hr = get_mix(client_ptr, byref(fmt))
        if hr < 0:
            return {"ok": False, "error": "GetMixFormat failed"}
        sample_rate = int(fmt.contents.nSamplesPerSec) if fmt else 48000

        initialize = vtable_fn(
            client_ptr,
            3,
            HRESULT,
            [
                ctypes.c_void_p,
                DWORD,
                DWORD,
                c_longlong,
                c_longlong,
                ctypes.c_void_p,
                ctypes.c_void_p,
            ],
        )
        hns = int(sample_ms / 1000.0 * 10_000_000)
        hr = initialize(client_ptr, 0, 0, hns, 0, ctypes.cast(fmt, ctypes.c_void_p), None)
        if hr < 0:
            return {"ok": False, "error": f"IAudioClient::Initialize failed (0x{hr & 0xFFFFFFFF:08x})"}

        IID_CAPTURE = _uuid.UUID("{C8ADBD64-E71E-48A0-A4DE-185C395CD317}")
        get_service = vtable_fn(
            client_ptr, 14, HRESULT, [ctypes.c_void_p, ctypes.c_void_p, POINTER(ctypes.c_void_p)]
        )
        pCapture = ctypes.c_void_p()
        hr = get_service(
            client_ptr,
            ctypes.cast(ctypes.c_char_p(IID_CAPTURE.bytes_le), ctypes.c_void_p),
            byref(pCapture),
        )
        if hr < 0:
            return {"ok": False, "error": "GetService(IAudioCaptureClient) failed"}
        capture_ptr = ctypes.cast(pCapture, ctypes.c_void_p)

        start = vtable_fn(client_ptr, 10, HRESULT, [ctypes.c_void_p])
        start(client_ptr)

        import time

        samples: List[int] = []
        get_buffer = vtable_fn(
            capture_ptr,
            3,
            HRESULT,
            [
                ctypes.c_void_p,
                POINTER(POINTER(ctypes.c_ubyte)),
                POINTER(ctypes.c_uint32),
                POINTER(ctypes.c_uint32),
                POINTER(ctypes.c_uint64),
                POINTER(ctypes.c_uint64),
            ],
        )
        release_buffer = vtable_fn(capture_ptr, 4, HRESULT, [ctypes.c_void_p, ctypes.c_uint32])

        deadline = time.monotonic() + sample_ms / 1000.0 + 0.15
        frames_collected = 0
        data_ptr = POINTER(ctypes.c_ubyte)()
        num_frames = ctypes.c_uint32()
        flags = ctypes.c_uint32()
        dev_pos = ctypes.c_uint64()
        qpc = ctypes.c_uint64()

        while time.monotonic() < deadline and frames_collected < 200_000:
            hr = get_buffer(capture_ptr, byref(data_ptr), byref(num_frames), byref(flags), byref(dev_pos), byref(qpc))
            if hr < 0:
                break
            if num_frames.value == 0:
                time.sleep(0.01)
                continue
            n = int(num_frames.value)
            raw = ctypes.string_at(data_ptr, n * 2)
            for i in range(0, len(raw) - 1, 2):
                samples.append(int.from_bytes(raw[i : i + 2], "little", signed=True))
            frames_collected += n
            release_buffer(capture_ptr, n)

        stop = vtable_fn(client_ptr, 11, HRESULT, [ctypes.c_void_p])
        stop(client_ptr)

        if not samples:
            return {
                "ok": False,
                "error": "captured 0 frames from the default microphone",
                "sampleRate": sample_rate,
            }

        mean_sq = sum(s * s for s in samples) / len(samples)
        rms = math.sqrt(mean_sq) / 32768.0
        peak = max(abs(s) for s in samples) / 32768.0
        return {
            "ok": True,
            "sampleRate": sample_rate,
            "frames": len(samples),
            "durationMs": round(len(samples) / max(1, sample_rate) * 1000),
            "rms": round(rms, 4),
            "peak": round(peak, 4),
            "hasSignal": peak > 0.005,
            "note": "sample analysed locally; not transmitted",
        }

    import ctypes as _ct

    # COM is per-thread: worker requests may run on different pool threads, so
    # init/uninit must stay balanced on the SAME thread. CoInitialize returns
    # S_FALSE (1) when the thread is already initialized — in that case we must
    # NOT uninitialize (would tear down another consumer's COM state).
    co_hr = _ct.windll.ole32.CoInitialize(None)
    try:
        result = _capture()
    finally:
        try:
            if _wasapi_available() and co_hr == 0:
                _ct.windll.ole32.CoUninitialize()
        except Exception:
            pass
    return result


def diagnostic(sample_ms: int = 500) -> Dict[str, Any]:
    """Local microphone pipeline diagnostic (no external transmission)."""
    info = microphone_info()
    capture = _wasapi_capture_rms(int(sample_ms))
    capture["microphone"] = info
    return capture
