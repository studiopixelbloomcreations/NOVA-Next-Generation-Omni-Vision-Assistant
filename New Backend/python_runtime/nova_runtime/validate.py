"""Static validation of generated Python source (syntax + AST security checks).

Returns a report of violations. The New Backend Validation Engine calls this
via the bridge; a BLOCK prevents registration/execution.
"""
from __future__ import annotations

import ast
import json
import sys
from typing import Any, Dict, List

# Imports generated tool code must not use.
_BANNED_IMPORTS = {
    "subprocess", "socket", "multiprocessing", "pickle", "marshal", "shelve",
    "pty", "posix", "grp", "pwd", "ftplib", "telnetlib", "smtplib", "imaplib",
    "poplib", "ctypes",
}

# Calls that must never appear.
_BANNED_CALLS = {
    "os.system", "os.popen", "os.remove", "os.unlink", "os.rmdir",
    "shutil.rmtree", "eval", "exec", "__import__", "compile",
}


def _walk(node: ast.AST, state: List[str]) -> None:
    for child in ast.iter_child_nodes(node):
        if isinstance(child, ast.Import):
            for alias in child.names:
                root = (alias.name or "").split(".")[0]
                if root in _BANNED_IMPORTS:
                    state.append(f"banned import: {alias.name}")
        elif isinstance(child, ast.ImportFrom):
            if child.module and child.module.split(".")[0] in _BANNED_IMPORTS:
                state.append(f"banned import: {child.module}")
        elif isinstance(child, ast.Call):
            fn = getattr(child.func, "attr", None) or getattr(child.func, "id", None)
            if isinstance(child.func, ast.Attribute):
                base = getattr(child.func.value, "id", None)
                if base and fn:
                    call = f"{base}.{fn}"
                    if call in _BANNED_CALLS:
                        state.append(f"banned call: {call}")
            elif isinstance(fn, str) and fn in ("eval", "exec", "compile", "__import__"):
                state.append(f"banned call: {fn}")
        _walk(child, state)


def validate_source(source: str) -> Dict[str, Any]:
    violations: List[str] = []
    # 1. Syntax + AST parse.
    try:
        tree = ast.parse(source, mode="exec")
    except SyntaxError as exc:
        return {"valid": False, "syntax": False, "violations": [f"syntax error: {exc.msg} at line {exc.lineno}"]}

    # 2. AST security scan.
    _walk(tree, violations)

    # 3. Entry point presence.
    has_run = any(
        isinstance(n, ast.FunctionDef) and n.name == "run"
        for n in ast.walk(tree)
    )
    if not has_run:
        violations.append("no run(params) entry point")

    return {"valid": len(violations) == 0, "syntax": True, "violations": violations}


if __name__ == "__main__":  # pragma: no cover
    req = json.load(sys.stdin)
    source = req.get("source", "")
    print(json.dumps(validate_source(source)))
    sys.stdout.flush()
