"""Directory analysis service (real filesystem operations)."""
from __future__ import annotations

import json
import os
import sys
from typing import Any, Dict, List


def largest_files(directory: str, n: int = 5, exclude_hidden: bool = True) -> Dict[str, Any]:
    """Return the N largest files under a directory (non-recursive by default
    for safety; recursive when `recursive` is true)."""
    target = os.path.abspath(directory)
    if not os.path.isdir(target):
        return {"success": False, "error": f"directory not found: {target}"}
    entries: List[Dict[str, Any]] = []
    total_files = 0
    total_bytes = 0
    for name in os.listdir(target):
        if exclude_hidden and name.startswith("."):
            continue
        path = os.path.join(target, name)
        try:
            if os.path.isfile(path):
                size = os.path.getsize(path)
                total_files += 1
                total_bytes += size
                entries.append({"name": name, "path": path, "sizeBytes": size})
        except OSError:
            continue
    entries.sort(key=lambda e: e["sizeBytes"], reverse=True)
    largest = entries[: max(1, min(n, 100))]
    return {
        "success": True,
        "directory": target,
        "fileCount": total_files,
        "totalBytes": total_bytes,
        "largest": largest,
        "largestFile": largest[0] if largest else None,
    }


def list_dir(directory: str, limit: int = 200) -> Dict[str, Any]:
    target = os.path.abspath(directory)
    if not os.path.isdir(target):
        return {"success": False, "error": f"directory not found: {target}"}
    items: List[Dict[str, Any]] = []
    for name in sorted(os.listdir(target))[:limit]:
        path = os.path.join(target, name)
        try:
            is_dir = os.path.isdir(path)
            items.append({
                "name": name,
                "path": path,
                "type": "dir" if is_dir else "file",
                "sizeBytes": None if is_dir else os.path.getsize(path),
            })
        except OSError:
            continue
    return {"success": True, "directory": target, "items": items, "count": len(items)}


if __name__ == "__main__":  # pragma: no cover
    req = json.load(sys.stdin)
    cmd = req.get("cmd", "list")
    if cmd == "largest":
        print(json.dumps(largest_files(str(req.get("directory", ".")), int(req.get("n", 5)))))
    else:
        print(json.dumps(list_dir(str(req.get("directory", ".")), int(req.get("limit", 200)))))
    sys.stdout.flush()
