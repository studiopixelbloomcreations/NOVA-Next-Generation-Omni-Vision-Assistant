#!/usr/bin/env python3
"""NOVA Python backend bootstrap.

Creates (or repairs) the `.nova-venv` virtual environment next to this file,
installs the declared runtime requirements, and prints a JSON status line.
Missing required runtime dependencies are reported as failures instead of
being silently treated as a healthy installation.

Usage:
    python bootstrap.py            # create venv + install requirements
    python bootstrap.py --status   # report venv/module availability only
"""
import argparse
import json
import subprocess
import sys
import venv
from pathlib import Path

PACKAGE_DIR = Path(__file__).resolve().parent
VENV_DIR = PACKAGE_DIR / ".nova-venv"
REQUIREMENTS = PACKAGE_DIR / "requirements.txt"


def venv_python() -> Path:
    if sys.platform == "win32":
        return VENV_DIR / "Scripts" / "python.exe"
    return VENV_DIR / "bin" / "python"


def module_availability(python: Path) -> dict:
    probe = (
        "import importlib.util, json\n"
        "mods = {}\n"
        "for m in ['PIL', 'pytesseract', 'pyautogui', 'faster_whisper', 'numpy']:\n"
        "    mods[m] = importlib.util.find_spec(m) is not None\n"
        "print(json.dumps(mods))\n"
    )
    try:
        result = subprocess.run(
            [str(python), "-c", probe], capture_output=True, text=True, timeout=60
        )
        if result.returncode == 0 and result.stdout.strip():
            return json.loads(result.stdout.strip())
    except Exception:
        pass
    return {"PIL": False, "pytesseract": False, "pyautogui": False, "faster_whisper": False, "numpy": False}


def status() -> dict:
    exists = venv_python().exists()
    modules = module_availability(venv_python()) if exists else {}
    whisper_ready = bool(exists and modules.get("faster_whisper") and modules.get("numpy"))
    return {
        "venvExists": exists,
        "venvPath": str(VENV_DIR),
        "python": str(venv_python()) if exists else None,
        "modules": modules,
        "whisperReady": whisper_ready,
        "coreOnly": not whisper_ready,
    }


def bootstrap(install: bool = True) -> dict:
    if not VENV_DIR.exists():
        print(f"[nova-bootstrap] creating virtual environment at {VENV_DIR}")
        venv.EnvBuilder(with_pip=True).create(VENV_DIR)
    python = venv_python()
    if install and REQUIREMENTS.exists():
        print("[nova-bootstrap] installing declared Python requirements")
        try:
            subprocess.run(
                [str(python), "-m", "pip", "install", "--disable-pip-version-check", "-r", str(REQUIREMENTS)],
                check=True,
                timeout=600,
            )
        except Exception as exc:  # noqa: BLE001
            print(f"[nova-bootstrap] pip install failed: {exc}", file=sys.stderr)
            raise
    result = status()
    if install and not result["whisperReady"]:
        raise RuntimeError("NOVA Python bootstrap completed without a usable faster-whisper runtime")
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description="NOVA Python backend bootstrap")
    parser.add_argument("--status", action="store_true", help="report status and exit")
    parser.add_argument("--no-install", action="store_true", help="create venv without pip install")
    args = parser.parse_args()

    try:
        if args.status:
            print(json.dumps(status()))
            return 0
        print(json.dumps(bootstrap(install=not args.no_install)))
        return 0
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"ok": False, "error": str(exc)}))
        return 1


if __name__ == "__main__":
    sys.exit(main())
