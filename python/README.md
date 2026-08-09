# NOVA Python Backend

A stdlib-only JSON-RPC service that NOVA's Electron main process drives as a
persistent worker. It owns system introspection, sandboxed filesystem access,
OCR (when the optional stack is installed), and desktop automation.

```
python/
├── nova_runtime/
│   ├── __main__.py          CLI entry (`python -m nova_runtime --stdio`)
│   ├── core/
│   │   ├── config.py        roots, caps, concurrency (from env)
│   │   └── ipc.py           JSON-line framing
│   ├── runtime/
│   │   └── worker.py        asyncio stdio loop, dispatch, error recovery
│   └── services/
│       ├── system.py        platform / CPU / memory / disks / processes
│       ├── filesystem.py    sandboxed list/read/write/search
│       ├── ocr.py           pytesseract OCR (optional)
│       └── automation.py    launch + pyautogui (optional)
├── bootstrap.py             venv bootstrap + optional extras
└── requirements.txt         optional extras (pillow, pytesseract, pyautogui)
```

## Running

Core runtime (no dependencies):

```bash
cd python
python -m nova_runtime --ping          # one-shot probe
printf '{"id":1,"method":"ping","params":{}}\n' | python -m nova_runtime --stdio
```

Optional extras (venv):

```bash
cd python
python bootstrap.py                    # creates .nova-venv + installs extras
python bootstrap.py --status           # report availability
```

## Protocol

One JSON object per line on stdin; one JSON object per line on stdout.
Requests: `{"id": int, "method": str, "params": {}}`.
Responses: `{"id": int, "result": ...}` or `{"id": int, "error": {"code", "message"}}`.

| Method | Params | Returns |
|---|---|---|
| `ping` | — | `{ok, runtime}` |
| `system.info` | — | platform, CPU, memory, disks |
| `system.processes` | `limit` | capped process snapshot |
| `fs.list` | `path` | directory entries |
| `fs.read` | `path` | file content (size-capped) |
| `fs.write` | `path, content` | write result (size-capped) |
| `fs.stat` | `path` | metadata |
| `fs.search` | `root, needle, max_results` | filename hits |
| `ocr.availability` | — | module availability |
| `ocr.image` | `path, lang` | extracted text |
| `automation.availability` | — | pyautogui availability |
| `automation.launch` | `target` | launch via OS shell |
| `automation.type_text` | `text` | keyboard (requires pyautogui) |
| `automation.screenshot` | `monitor` | base64 PNG (requires pyautogui) |

## Security

- **Filesystem sandbox:** every path is resolved and verified against
  `NOVA_PYTHON_ROOTS` before access; escaping raises a permission error. File
  sizes are capped (`NOVA_PYTHON_MAX_FS_BYTES`).
- **No secrets:** the Electron bridge spawns the worker with a scrubbed
  environment, so API keys never reach Python.
- **Failure isolation:** every handler error becomes an error response; the
  worker never crashes its parent.
- **Concurrency cap:** requests are dispatched under
  `NOVA_PYTHON_MAX_CONCURRENCY` (default 4).

## Electron integration

`src/main/services/python_runtime.ts` starts the worker with
`python -m nova_runtime --stdio`, sends JSON-RPC requests with per-request
timeouts, and restarts it with exponential backoff if it exits. Builtin tools
(`python_info`, `python_ocr`) route through it, falling back to one-shot
scripts when the worker is unavailable.
