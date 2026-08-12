"""Isolated sandbox runner for forged-tool validation.

The generated test file is copied (with its tool.py) into a throwaway temp
directory and executed as its own subprocess under a scrubbed environment and a
hard wall-clock timeout. The sandbox NEVER runs production user actions — it
only runs the tool's own tests against synthetic inputs.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
from typing import Any, Dict

_SCRUB = ("API_KEY", "SECRET", "TOKEN", "PASSWORD", "PICOVOICE")


def _scrubbed_env() -> Dict[str, str]:
    env = dict(os.environ)
    for key in list(env):
        if any(k in key.upper() for k in _SCRUB):
            env.pop(key, None)
    return env


def sandbox_test(tool_path: str, test_path: str, timeout_ms: int = 30000) -> Dict[str, Any]:
    """Run the generated test in an isolated temp dir. Returns {passed, output}."""
    # Resolve the real file paths (the caller may pass relative paths).
    tool_abs = os.path.abspath(tool_path)
    test_abs = os.path.abspath(test_path)
    if not os.path.exists(tool_abs):
        return {"passed": False, "output": f"tool.py not found: {tool_abs}"}
    if not os.path.exists(test_abs):
        return {"passed": False, "output": f"test file not found: {test_abs}"}

    workdir = tempfile.mkdtemp(prefix="nova_sandbox_")
    try:
        # Copy tool.py + the test file into the isolated working dir so the
        # test's `from tool import run` resolves against the tool under test.
        shutil.copy(tool_abs, os.path.join(workdir, "tool.py"))
        test_dest = os.path.join(workdir, os.path.basename(test_abs))
        shutil.copy(test_abs, test_dest)

        try:
            proc = subprocess.run(
                [sys.executable, test_dest],
                cwd=workdir,
                env=_scrubbed_env(),
                capture_output=True,
                text=True,
                timeout=timeout_ms / 1000.0,
            )
        except subprocess.TimeoutExpired:
            return {"passed": False, "output": f"sandbox test timed out after {timeout_ms}ms"}

        combined = (proc.stdout or "") + (proc.stderr or "")
        if proc.returncode != 0:
            return {"passed": False, "output": combined[-4000:] or "test exited non-zero"}
        if "ALL_TESTS_PASSED" not in (proc.stdout or ""):
            return {"passed": False, "output": combined[-4000:] or "tests did not report ALL_TESTS_PASSED"}
        return {"passed": True, "output": combined[-2000:]}
    finally:
        shutil.rmtree(workdir, ignore_errors=True)


if __name__ == "__main__":  # pragma: no cover - invoked via -m entry
    params = json.load(sys.stdin)
    print(json.dumps(sandbox_test(
        params.get("tool_path", ""),
        params.get("test_path", ""),
        int(params.get("timeout_ms", 30000)),
    )))
    sys.stdout.flush()
