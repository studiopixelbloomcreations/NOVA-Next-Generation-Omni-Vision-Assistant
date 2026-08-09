"""Persistent stdio worker for the NOVA Python backend.

Reads JSON-line requests on stdin, dispatches them to the registered services
under a concurrency cap, and writes JSON-line responses on stdout. Every
failure is converted into an error response so the Electron bridge can recover
and, if needed, restart the worker — the worker never crashes the parent.

Services are registered in a plain mapping; adding a service is a one-line
change, keeping the backend modular and testable.
"""
import asyncio
import sys
import traceback
from typing import Any, Callable, Dict

from nova_runtime.core import config
from nova_runtime.core.ipc import read_request, write_response
from nova_runtime.services import audio, automation, filesystem, forge, ocr, system, whisper, windows

Handler = Callable[[Dict[str, Any]], Any]

SERVICES: Dict[str, Handler] = {
    "ping": lambda _p: {"ok": True, "runtime": "nova"},
    "system.info": lambda p: system.system_info(),
    "system.processes": lambda p: system.top_processes(int(p.get("limit", 25))),
    "fs.list": lambda p: filesystem.list_dir(str(p.get("path", "."))),
    "fs.read": lambda p: filesystem.read_file(str(p.get("path", ""))),
    "fs.write": lambda p: filesystem.write_file(str(p.get("path", "")), str(p.get("content", ""))),
    "fs.stat": lambda p: filesystem.stat(str(p.get("path", ""))),
    "fs.search": lambda p: filesystem.search(
        str(p.get("root", ".")), str(p.get("needle", "")), int(p.get("max_results", 50))
    ),
    "ocr.availability": lambda _p: ocr.availability(),
    "ocr.image": lambda p: ocr.ocr_image(str(p.get("path", "")), str(p.get("lang", "eng"))),
    "automation.availability": lambda _p: automation.availability(),
    "automation.launch": lambda p: automation.launch(str(p.get("target", ""))),
    "automation.type_text": lambda p: automation.type_text(str(p.get("text", ""))),
    "automation.mouse_move": lambda p: automation.mouse_move(
        int(p.get("x", 0)), int(p.get("y", 0))
    ),
    "automation.mouse_click": lambda p: automation.mouse_click(
        int(p["x"]) if "x" in p else None,
        int(p["y"]) if "y" in p else None,
        str(p.get("button", "left")),
        int(p.get("clicks", 1)),
    ),
    "automation.mouse_double_click": lambda p: automation.mouse_double_click(
        int(p["x"]) if "x" in p else None,
        int(p["y"]) if "y" in p else None,
    ),
    "automation.mouse_drag": lambda p: automation.mouse_drag(
        int(p.get("x1", 0)), int(p.get("y1", 0)), int(p.get("x2", 0)), int(p.get("y2", 0)),
        float(p.get("duration", 0.3)),
    ),
    "automation.mouse_scroll": lambda p: automation.mouse_scroll(int(p.get("clicks", 1))),
    "automation.keyboard_press": lambda p: automation.keyboard_press(
        str(p.get("key", "")), int(p.get("repeat", 1))
    ),
    "automation.keyboard_hotkey": lambda p: automation.keyboard_hotkey(str(p.get("combo", ""))),
    "automation.screenshot": lambda p: automation.screenshot(int(p.get("monitor", 0))),
    "automation.screenshot_region": lambda p: automation.screenshot_region(
        int(p.get("x", 0)), int(p.get("y", 0)), int(p.get("width", 800)), int(p.get("height", 600))
    ),
    "automation.screen_ocr": lambda _p: automation.screen_ocr(),
    "audio.devices": lambda _p: audio.devices(),
    "audio.microphone_info": lambda _p: audio.microphone_info(),
    "audio.diagnostic": lambda p: audio.diagnostic(int(p.get("sample_ms", 500))),
    "whisper.status": lambda _p: whisper.status(),
    "whisper.warmup": lambda _p: whisper.warmup(),
    "whisper.audio": lambda p: whisper.audio(p),
    "whisper.reset": lambda _p: whisper.reset(),
    "win.active_window": lambda _p: windows.active_window(),
    "win.window_list": lambda p: windows.window_list(int(p.get("limit", 50))),
    "win.process_list": lambda p: windows.process_list(int(p.get("limit", 30))),
    "win.uptime": lambda _p: {"seconds": windows.system_uptime_seconds()},
    "win.window_focus": lambda p: windows.window_focus(str(p.get("title", ""))),
    "win.window_minimize": lambda p: windows.window_minimize(str(p.get("title", ""))),
    "win.window_maximize": lambda p: windows.window_maximize(str(p.get("title", ""))),
    "win.window_restore": lambda p: windows.window_restore(str(p.get("title", ""))),
    "win.window_move": lambda p: windows.window_move(
        str(p.get("title", "")),
        int(p.get("x", 0)),
        int(p.get("y", 0)),
        int(p["width"]) if "width" in p else None,
        int(p["height"]) if "height" in p else None,
    ),
    # Tool Forge: PRODUCTION execution of registered forged tools, and the
    # ISOLATED sandbox test runner used during validation. These are kept
    # separate by design — sandbox tests never touch the real machine, and
    # production execution never runs untested code.
    "forge.availability": lambda _p: forge.availability(),
    "forge.run": lambda p: forge.run(
        str(p.get("tool_path", "")), p.get("params") or {}
    ),
    "forge.test": lambda p: forge.test(
        str(p.get("tool_path", "")),
        str(p.get("test_path", "")),
        int(p.get("timeout_ms", 30000)),
    ),
}


async def _dispatch(sem: asyncio.Semaphore, req: Dict[str, Any]) -> Dict[str, Any]:
    req_id = req.get("id")
    method = req.get("method", "")
    params = req.get("params") or {}

    if not isinstance(params, dict):
        params = {}

    if method not in SERVICES:
        return {"id": req_id, "error": {"code": -32601, "message": f"unknown method: {method}"}}

    async with sem:
        try:
            result = SERVICES[method](params)
            if hasattr(result, "__await__"):
                result = await result
            return {"id": req_id, "result": result}
        except Exception as exc:  # noqa: BLE001 — every error becomes a response
            if config.PYTHON_LOG_LEVEL == "debug":
                traceback.print_exc(file=sys.stderr)
            return {
                "id": req_id,
                "error": {
                    "code": -32000,
                    "message": f"{type(exc).__name__}: {exc}",
                },
            }


def write_json(payload: Dict[str, Any]) -> None:
    """Writes one JSON response line to stdout (bytes-level, Windows-safe).

    Direct buffered writes avoid the Windows proactor pipe transports, which
    fail with WinError 6 on stdin/stdout handles in some shells.
    """
    write_response(sys.stdout.buffer, payload)


async def _run_stdio() -> None:
    loop = asyncio.get_running_loop()
    sem = asyncio.Semaphore(config.MAX_CONCURRENCY)
    while True:
        req = await loop.run_in_executor(None, read_request, sys.stdin)
        if req is None:
            break
        if req.get("method") == "_invalid":
            write_json({"id": req.get("id"), "error": {"code": -32700, "message": "parse error"}})
            continue
        response = await _dispatch(sem, req)
        write_json(
            {
                "id": response.get("id"),
                **({"result": response.get("result")} if "result" in response else {}),
                **({"error": response.get("error")} if "error" in response else {}),
            }
        )


def run_stdio_worker() -> int:
    try:
        asyncio.run(_run_stdio())
    except KeyboardInterrupt:
        return 0
    except Exception:
        traceback.print_exc(file=sys.stderr)
        return 1
    return 0
