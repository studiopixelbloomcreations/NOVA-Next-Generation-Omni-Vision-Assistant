"""NOVA New Backend — Python runtime entry point.

Usage (one-shot, JSON on stdin, JSON result on stdout):
    python nova_runtime/__main__.py <mode>

Modes:
    sandbox-test   -> {tool_path, test_path, timeout_ms} -> {passed, output}
    tool-run       -> {tool_path, params}                -> {success, result?, error?}
    system-info    -> {}                                  -> host snapshot
    fs-largest     -> {directory, n}                      -> largest files
    check-syntax   -> {source}                            -> AST validation report
"""
from __future__ import annotations

import json
import sys

from . import runtool, sandbox, system, fs, validate


def dispatch(mode: str, params: dict):
    if mode == "sandbox-test":
        return sandbox.sandbox_test(
            str(params.get("tool_path", "")),
            str(params.get("test_path", "")),
            int(params.get("timeout_ms", 30000)),
        )
    if mode == "tool-run":
        return runtool.run_tool(str(params.get("tool_path", "")), params.get("params", {}) or {})
    if mode == "system-info":
        return system.system_info()
    if mode == "system-processes":
        return {"processes": system.top_processes(int(params.get("limit", 25)))}
    if mode == "fs-largest":
        return fs.largest_files(str(params.get("directory", ".")), int(params.get("n", 5)))
    if mode == "fs-list":
        return fs.list_dir(str(params.get("directory", ".")), int(params.get("limit", 200)))
    if mode == "check-syntax":
        return validate.validate_source(str(params.get("source", "")))
    return {"success": False, "error": f"unknown mode: {mode}"}


def main() -> None:
    line = sys.stdin.readline()
    if not line:
        print(json.dumps({"success": False, "error": "no input"}))
        return
    try:
        req = json.loads(line)
    except json.JSONDecodeError:
        print(json.dumps({"success": False, "error": "invalid json input"}))
        return
    mode = str(req.get("mode", ""))
    params = req.get("params", {}) or {}
    result = dispatch(mode, params)
    # Print the raw result object. The bridge parses the last JSON line and
    # treats exit code 0 as transport success; domain success/failure is
    # carried by the payload's own "success" field where applicable.
    print(json.dumps(result))
    sys.stdout.flush()


if __name__ == "__main__":
    main()
