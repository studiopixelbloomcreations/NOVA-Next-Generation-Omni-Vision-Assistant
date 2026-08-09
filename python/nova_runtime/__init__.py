"""NOVA Python backend.

A stdlib-only JSON-RPC-over-stdio service that NOVA's Electron main process
drives as a persistent worker. It owns system introspection, sandboxed
filesystem access, OCR (when pytesseract is available) and OS automation.

Run directly:  python -m nova_runtime --stdio
"""
__version__ = "1.0.0"
