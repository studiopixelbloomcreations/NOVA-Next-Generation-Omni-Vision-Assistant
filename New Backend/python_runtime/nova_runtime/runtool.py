"""Production runner for registered forged tools.

Loads a validated tool.py module and invokes its run(params) entry point
against the REAL machine. The sandbox is for validation only; this is where
real user-requested actions execute. Only tools that already passed the
isolated sandbox tests reach this path (enforced by the Tool Forge).
"""
from __future__ import annotations

import importlib.util
import json
import os
import sys
from typing import Any, Dict


def _load_module(tool_path: str):
    spec = importlib.util.spec_from_file_location("nova_forged_tool", tool_path)
    if spec is None or spec.loader is None:
        raise ImportError(f"cannot load tool module from {tool_path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def run_tool(tool_path: str, params: Dict[str, Any]) -> Dict[str, Any]:
    tool_abs = os.path.abspath(tool_path)
    if not os.path.exists(tool_abs):
        return {"success": False, "error": f"tool.py not found: {tool_abs}"}
    try:
        module = _load_module(tool_abs)
        fn = getattr(module, "run", None)
        if not callable(fn):
            return {"success": False, "error": "forged tool must expose a callable run(params)"}
        result = fn(params or {})
        if hasattr(result, "to_dict"):
            result = result.to_dict()
        if not isinstance(result, dict):
            return {"success": True, "result": result}
        if result.get("success") is False:
            return {"success": False, "error": result.get("error", "tool reported failure"), "result": result}
        return {"success": True, "result": result}
    except Exception as exc:  # noqa: BLE001 - surfaced to the bridge for recovery
        return {"success": False, "error": f"{type(exc).__name__}: {exc}"}


if __name__ == "__main__":  # pragma: no cover
    params = json.load(sys.stdin)
    tool_path = params.get("tool_path", "")
    payload = params.get("params", {})
    print(json.dumps(run_tool(tool_path, payload)))
    sys.stdout.flush()
