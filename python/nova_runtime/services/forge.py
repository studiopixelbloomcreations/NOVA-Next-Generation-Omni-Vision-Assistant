"""NOVA Tool Forge — production runtime for forged Python tools.

Two responsibilities, kept strictly separate:

* ``forge.test`` — run a generated test file in an ISOLATED sandbox. The test
  runs as its own subprocess with a scrubbed environment (no API keys), a hard
  timeout, and a working directory that is a throwaway temp dir. This is the
  ONLY place generated code is executed during validation.
* ``forge.run`` — execute a REGISTERED forged tool in PRODUCTION against the
  real machine. The module is loaded from the NOVA tools root (validated to be
  inside the allowed roots) and its ``run(params)`` entry point is invoked.

The sandbox never runs production actions; production never runs untested code.
"""
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
from typing import Any, Dict

from nova_runtime.core import config


def _tools_root() -> str:
    return config.TOOLS_ROOT


def _sdk_path() -> str:
    # nova_tool_sdk.py lives beside the nova_runtime package in the Python root.
    return os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(__file__))), "nova_tool_sdk.py")


def _is_within(root: str, path: str) -> bool:
    root_abs = os.path.abspath(root)
    path_abs = os.path.abspath(path)
    return path_abs == root_abs or path_abs.startswith(root_abs + os.sep)


def _scrubbed_env() -> Dict[str, str]:
    env = dict(os.environ)
    for key in list(env):
        if any(k in key.upper() for k in ("API_KEY", "SECRET", "TOKEN", "PASSWORD", "PICOVOICE")):
            env.pop(key, None)
    return env


def _load_module(tool_path: str):
    # The SDK is deliberately exposed as a curated module. Generated tools may
    # import it, while they never receive direct access to arbitrary host APIs.
    package_root = os.path.dirname(_sdk_path())
    if package_root not in sys.path:
        sys.path.insert(0, package_root)
    spec = importlib.util.spec_from_file_location("nova_forged_tool", tool_path)
    if spec is None or spec.loader is None:
        raise ImportError(f"cannot load tool module from {tool_path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def _run_function(module, params: Dict[str, Any]) -> Any:
    fn = getattr(module, "run", None)
    if not callable(fn):
        raise TypeError("forged tool must expose a callable run(params)")
    result = fn(params or {})
    if hasattr(result, "to_dict"):
        result = result.to_dict()
    try:
        json.dumps(result)
        return result
    except (TypeError, ValueError):
        return {"success": False, "error": "tool returned a non-serializable result"}


def run(tool_path: str, params: Dict[str, Any] | None = None) -> Dict[str, Any]:
    """Production execution of a registered forged tool on the real machine."""
    if not _is_within(_tools_root(), tool_path):
        raise PermissionError(f"tool path is outside the NOVA tools root: {tool_path}")
    if not os.path.isfile(tool_path):
        raise FileNotFoundError(f"forged tool source missing: {tool_path}")
    module = _load_module(tool_path)
    result = _run_function(module, params or {})
    return {"ok": True, "result": result}


def test(tool_path: str, test_path: str, timeout_ms: int = 30000) -> Dict[str, Any]:
    """Run a generated test file in an isolated sandbox subprocess.

    The test file is executed with a throwaway temp working directory, a
    scrubbed environment, a hard timeout, and a NON-DESTRUCTIVE SDK shim.
    Production SDK operations are never allowed to touch the real machine
    during validation. The shim records capability calls and returns realistic
    deterministic values so tests can validate the generated tool's logic.
    """
    if not _is_within(_tools_root(), tool_path):
        raise PermissionError(f"tool path is outside the NOVA tools root: {tool_path}")
    if not os.path.isfile(tool_path):
        raise FileNotFoundError(f"forged tool source missing: {tool_path}")
    if not os.path.isfile(test_path):
        raise FileNotFoundError(f"forged test source missing: {test_path}")

    sandbox_dir = tempfile.mkdtemp(prefix="nova-forge-sandbox-")
    try:
        sandbox_tool = os.path.join(sandbox_dir, "tool.py")
        sandbox_test = os.path.join(sandbox_dir, "test_tool.py")
        sandbox_sdk = os.path.join(sandbox_dir, "nova_tool_sdk.py")
        with open(tool_path, "r", encoding="utf-8") as f_src, open(sandbox_tool, "w", encoding="utf-8") as f_dst:
            f_dst.write(f_src.read())
        with open(test_path, "r", encoding="utf-8") as f_src, open(sandbox_test, "w", encoding="utf-8") as f_dst:
            f_dst.write(f_src.read())

        # Replace the production SDK with a harmless test double. The generated
        # source remains real Python and is exercised end-to-end, but operations
        # such as launch/type/click/write cannot affect the host during Forge.
        shim = '''"""Non-destructive NOVA Forge SDK shim."""
import base64

def _ok(**data): return {"success": True, **data}
def _fail(message, **data): return {"success": False, "error": message, **data}
def system_info(params=None): return _ok(system="Windows", platform="Windows", machine="sandbox", python="sandbox")
def active_window(params=None): return _ok(hwnd=1, pid=1234, title="NOVA Forge Sandbox")
def launch(target, params=None): return _ok(target=str(target), simulated=True)
def close_process(target, params=None): return _ok(target=str(target), simulated=True)
def type_text(text, params=None): return _ok(chars=len(str(text)), simulated=True)
def key_press(keys, params=None): return _ok(keys=str(keys), simulated=True)
def clipboard_get(params=None): return _ok(text="NOVA_SANDBOX_CLIPBOARD")
def clipboard_set(text, params=None): return _ok(length=len(str(text)), simulated=True)
def file_read(path, params=None): return _ok(path=str(path), text="NOVA_SANDBOX_FILE")
def file_write(path, content, params=None): return _ok(path=str(path), bytes=len(str(content).encode("utf-8")), simulated=True)
def screenshot(params=None): return _ok(data=base64.b64encode(b"PNG-SANDBOX").decode("ascii"), mimeType="image/png", width=1, height=1, simulated=True)
def web_get(url, params=None): return _ok(url=str(url), status=200, text="NOVA_SANDBOX_WEB_RESULT", simulated=True)
def sleep(seconds, params=None): return _ok(seconds=float(seconds), simulated=True)
def require(capability, params=None): return None
class ToolCapabilityError(RuntimeError): pass
'''
        with open(sandbox_sdk, "w", encoding="utf-8") as f_sdk:
            f_sdk.write(shim)

        timeout_s = max(1, timeout_ms / 1000.0)
        env = _scrubbed_env()
        env["PYTHONPATH"] = sandbox_dir
        proc = subprocess.run(
            [sys.executable, sandbox_test],
            cwd=sandbox_dir,
            env=env,
            capture_output=True,
            text=True,
            timeout=timeout_s,
        )
        output = (proc.stdout or "") + ("\n--- stderr ---\n" + (proc.stderr or "") if proc.stderr else "")
        passed = proc.returncode == 0 and "ALL_TESTS_PASSED" in output
        return {
            "ok": True,
            "passed": passed,
            "exitCode": proc.returncode,
            "output": output[-6000:],
        }
    except subprocess.TimeoutExpired:
        return {"ok": True, "passed": False, "exitCode": -1, "output": f"test timed out after {timeout_ms}ms"}
    finally:
        shutil.rmtree(sandbox_dir, ignore_errors=True)


def availability() -> Dict[str, Any]:
    return {
        "ok": True,
        "toolsRoot": _tools_root(),
        "exists": os.path.isdir(_tools_root()),
        "sdk": os.path.isfile(_sdk_path()),
    }
