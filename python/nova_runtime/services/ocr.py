"""OCR service.

Runs pytesseract over an image path when the optional stack is installed
(pillow + pytesseract + a tesseract binary). When it is missing, the service
reports availability honestly instead of fabricating results — the Electron
bridge surfaces that state to the user.
"""
from pathlib import Path
from typing import Any, Dict

from nova_runtime.core import config


def availability() -> Dict[str, bool]:
    modules: Dict[str, bool] = {}
    try:
        import PIL  # noqa: F401

        modules["PIL"] = True
    except Exception:
        modules["PIL"] = False
    try:
        import pytesseract  # noqa: F401

        modules["pytesseract"] = True
    except Exception:
        modules["pytesseract"] = False
    return modules


def _resolve_image(path_str: str) -> Path:
    raw = Path(path_str).expanduser()
    if not raw.is_absolute():
        raw = Path.cwd() / raw
    resolved = raw.resolve()
    if not resolved.is_file():
        raise FileNotFoundError(f"image not found: {path_str}")
    return resolved


def ocr_image(path_str: str, lang: str = "eng") -> Dict[str, Any]:
    mods = availability()
    if not mods.get("PIL") or not mods.get("pytesseract"):
        raise RuntimeError(
            "OCR unavailable: install the optional stack (pip install pillow pytesseract "
            "and a Tesseract binary), or point NOVA_PYTHON_PATH at a venv that has them."
        )
    image = _resolve_image(path_str)
    from PIL import Image
    import pytesseract

    text = pytesseract.image_to_string(Image.open(image), lang=lang)
    return {
        "path": str(image),
        "language": lang,
        "text": text,
        "charCount": len(text),
    }
