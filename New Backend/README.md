# NOVA Genesis — New Backend

The active, standalone backend for NOVA Genesis. A clean, modular,
engine-per-responsibility architecture that turns the existing NOVA UI into a
genuinely autonomous desktop AI. Electron-only + a local Python runtime + local
desktop execution. **No localhost server, no browser backend.**

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
  host & directory services (stdlib only).
- `src/tests/` — unit + integration tests (real pipelines).
- `scripts/demo.mjs` — CLI end-to-end demo.

## Entry points

- `NovaBackend` (`src/index.ts`) — public facade: `start()`, `handleRequest()`,
  `shutdown()`, plus runtime/capability/registry queries.
- `wireElectron(backend)` (`src/electron_adapter.ts`) — maps the backend onto
  the existing frontend IPC contract (UI unchanged).
- Electron main: `../src/main/nova2_main.ts` (ACTIVE). The legacy backend
  (`../src/main/main.ts`) is **LEGACY — DISABLED**.
