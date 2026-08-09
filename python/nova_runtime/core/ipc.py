"""JSON-line framing for the NOVA Python worker.

Protocol (one JSON object per line, newline-delimited):
  Request:  {"id": <int>, "method": "<name>", "params": {...}}
  Response: {"id": <int>, "result": {...}}
            {"id": <int>, "error": {"code": <int>, "message": "<str>"}}

Logging goes to stderr so stdout stays a pure data channel.
"""
import json
import sys
from typing import Any, Dict, Optional


def read_request(stream: Any) -> Optional[Dict[str, Any]]:
    """Reads one request object from the stream, or None at EOF."""
    line = stream.readline()
    if not line:
        return None
    line = line.strip()
    if not line:
        return read_request(stream)
    try:
        obj = json.loads(line)
    except json.JSONDecodeError:
        return {"id": None, "method": "_invalid", "params": {}}
    if not isinstance(obj, dict):
        return {"id": None, "method": "_invalid", "params": {}}
    return obj


def write_response(stream: Any, payload: Dict[str, Any]) -> None:
    """Writes one response line. Accepts a bytes buffer (sys.stdout.buffer)
    or a text stream; the payload is always UTF-8 encoded JSON."""
    encoded = (json.dumps(payload) + "\n").encode("utf-8")
    try:
        # BufferedWriter (stdout.buffer)
        stream.write(encoded)
    except TypeError:
        stream.write(encoded.decode("utf-8"))
    stream.flush()


def respond(stream: Any, req_id: Optional[int], result: Any = None, error: Optional[Dict[str, Any]] = None) -> None:
    payload: Dict[str, Any] = {"id": req_id}
    if error is not None:
        payload["error"] = error
    else:
        payload["result"] = result
    write_response(stream, payload)
