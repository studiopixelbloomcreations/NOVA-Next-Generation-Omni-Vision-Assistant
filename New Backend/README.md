# A.D.A.M. — New Backend (Autonomous Digital Analytical Mind)

The active, standalone backend for the A.D.A.M. desktop AI. A clean, modular,
engine-per-responsibility architecture that turns the existing NOVA UI into a
genuinely autonomous desktop AI. Electron-only + a local Python runtime + local
desktop execution. **No localhost server, no browser backend.**

- **Runtime identity:** A.D.A.M. / ADAM (wake word **ADAM**, voice **Charon**).
- **Reasoning/coding head:** Groq. **Conversational head:** Gemini Live.

See `../docs/NEW_BACKEND_ARCHITECTURE.md` (design) and
`../docs/NEW_BACKEND_VERIFICATION.md` (what was verified).

## Quick start (Node + Python 3)

```bash
npm install        # typescript, @types/node
npm test           # 29 unit + integration tests, all real (requires python3)
npm run demo       # real autonomous "analyze a directory" end-to-end run
npm run build      # ESM -> dist/
npm run build:cjs  # CommonJS -> dist-cjs/ (consumed by the Electron main)
```

## Layout

- `src/` — the backend source (contracts, engines, orchestration, facade).
- `python_runtime/nova_runtime/` — Python sandbox, tool runner, AST validator,
  host & directory services, **Windows automation (`win.py`)**, **microphone/
  Whisper (`audio.py`)**, and **Charon TTS (`tts.py`)**.
- `src/voice/` — wake word ADAM, mic lifecycle, Whisper streaming, Gemini Live
  bridge, Charon TTS, and the always-on VoiceEngine.
- `src/maintenance/` — Health, Error Observability, Maintenance, Self-Repair,
  Self-Maintenance Coordinator, Learning.
- `src/upgrades/` — Upgrade engine + Trial manager (auto-rollback).
- `src/diagnostics/` — Diagnostics engine.
- `src/tests/` — unit + integration tests (real pipelines).
- `scripts/demo.mjs` — CLI end-to-end demo.

## A.D.A.M. identity

Runtime AI identity is **A.D.A.M.** (wake word **ADAM**, voice **Charon**).
Prompts and personality derive from `src/contracts/identity.ts`. The repo name
and file paths keep historical NOVA references by design.

## Verification

See `../docs/CODEX_VERIFICATION_HANDOFF.md` for the independent Codex
verification protocol, and `../docs/ADAM_OMEGA_IMPLEMENTATION_REPORT.md` for
what is implemented vs. what requires a live Windows host.

## Entry points

- `NovaBackend` (`src/index.ts`) — public facade: `start()`, `handleRequest()`,
  `shutdown()`, plus runtime/capability/registry queries.
- `wireElectron(backend)` (`src/electron_adapter.ts`) — maps the backend onto
  the existing frontend IPC contract (UI unchanged).
- Electron main: `../src/main/nova2_main.ts` (ACTIVE). The legacy backend
  (`../src/main/main.ts`) is **LEGACY — DISABLED**.
