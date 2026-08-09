"""Sandboxed filesystem service.

Every operation is confined to the roots configured via NOVA_PYTHON_ROOTS.
Paths are resolved and verified before any access; escaping the sandbox raises
a permission error. Read/write sizes are capped by config.MAX_FS_BYTES.
"""
import os
from pathlib import Path
from typing import Any, Dict, List

from nova_runtime.core import config


def _resolve(path_str: str) -> Path:
    raw = Path(path_str).expanduser()
    if not raw.is_absolute():
        raw = Path.cwd() / raw
    resolved = raw.resolve()
    roots = [Path(r) for r in config.allowed_roots()]
    for root in roots:
        if resolved == root or root in resolved.parents:
            return resolved
    raise PermissionError(f"path outside the allowed sandbox roots: {path_str}")


def _stat_dict(p: Path) -> Dict[str, Any]:
    st = p.stat()
    return {
        "name": p.name,
        "path": str(p),
        "isDir": p.is_dir(),
        "isFile": p.is_file(),
        "sizeBytes": st.st_size,
        "modifiedAt": int(st.st_mtime * 1000),
    }


def list_dir(path_str: str = ".") -> Dict[str, Any]:
    target = _resolve(path_str)
    if not target.is_dir():
        raise FileNotFoundError(f"not a directory: {path_str}")
    entries: List[Dict[str, Any]] = []
    for child in sorted(target.iterdir()):
        try:
            entries.append(_stat_dict(child))
        except OSError:
            continue
    return {"path": str(target), "entries": entries}


def read_file(path_str: str) -> Dict[str, Any]:
    target = _resolve(path_str)
    if not target.is_file():
        raise FileNotFoundError(f"not a file: {path_str}")
    size = target.stat().st_size
    if size > config.MAX_FS_BYTES:
        raise ValueError(f"file exceeds size cap of {config.MAX_FS_BYTES} bytes")
    data = target.read_bytes()
    return {
        "path": str(target),
        "sizeBytes": len(data),
        "encoding": "utf-8",
        "content": data.decode("utf-8", errors="replace"),
    }


def write_file(path_str: str, content: str = "") -> Dict[str, Any]:
    target = _resolve(path_str)
    encoded = content.encode("utf-8")
    if len(encoded) > config.MAX_FS_BYTES:
        raise ValueError(f"write exceeds size cap of {config.MAX_FS_BYTES} bytes")
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(encoded)
    return {"path": str(target), "sizeBytes": len(encoded)}


def stat(path_str: str) -> Dict[str, Any]:
    return _stat_dict(_resolve(path_str))


def search(root: str, needle: str, max_results: int = 50) -> Dict[str, Any]:
    """Recursive filename substring search inside a sandbox root (bounded)."""
    base = _resolve(root)
    if not base.is_dir():
        raise FileNotFoundError(f"not a directory: {root}")
    capped = max(1, min(int(max_results), 200))
    needle_lower = needle.lower()
    hits: List[Dict[str, Any]] = []
    scanned = 0
    for current, dirs, files in os.walk(base):
        # Skip common noise directories.
        dirs[:] = [d for d in dirs if d not in (".git", "node_modules", "__pycache__", ".venv", "dist")]
        for name in files:
            scanned += 1
            if needle_lower in name.lower():
                try:
                    hits.append(_stat_dict(Path(current) / name))
                except OSError:
                    continue
                if len(hits) >= capped:
                    return {"root": str(base), "needle": needle, "scanned": scanned, "hits": hits}
    return {"root": str(base), "needle": needle, "scanned": scanned, "hits": hits}
