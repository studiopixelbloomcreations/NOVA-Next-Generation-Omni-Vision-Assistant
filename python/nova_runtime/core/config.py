"""Runtime configuration for the NOVA Python worker.

Values come from environment variables set by the Electron main process:
  NOVA_PYTHON_ROOTS  ;-separated absolute paths the filesystem service may touch
  NOVA_PYTHON_MAX_FS_BYTES  per-file read/write cap in bytes
  NOVA_PYTHON_MAX_CONCURRENCY  max concurrent request handlers
"""
import os
from pathlib import Path
from typing import List


def _bool(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() in ("1", "true", "yes", "on")


def _int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError:
        return default


def allowed_roots() -> List[str]:
    """Resolve the filesystem sandbox roots (absolute, deduplicated)."""
    raw = os.environ.get("NOVA_PYTHON_ROOTS", "")
    roots: List[str] = []
    for part in raw.split(";"):
        part = part.strip()
        if not part:
            continue
        try:
            resolved = str(Path(part).resolve())
        except OSError:
            continue
        if resolved not in roots:
            roots.append(resolved)
    if not roots:
        # Default: the current working directory only (usually the repo root).
        roots.append(str(Path.cwd().resolve()))
    return roots


MAX_FS_BYTES = _int("NOVA_PYTHON_MAX_FS_BYTES", 8 * 1024 * 1024)
MAX_CONCURRENCY = _int("NOVA_PYTHON_MAX_CONCURRENCY", 4)
PYTHON_LOG_LEVEL = os.environ.get("NOVA_PYTHON_LOG_LEVEL", "info").lower()

# Root directory that holds forged tools (production + sandbox validation).
# Set by the Electron main process from NovaConfig.paths.toolsRoot.
TOOLS_ROOT = os.environ.get("NOVA_TOOLS_ROOT", "") or os.path.join(os.getcwd(), "tools")
