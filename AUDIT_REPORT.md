# NOVA Genesis — Production Audit & Refactor Report

**Date:** August 7, 2026
**Scope:** Full repository audit and production hardening of NOVA Genesis
(formerly `nova-genesis-core`), an Electron desktop AI assistant.
**Outcome:** The project was converted from a prototype into a modular,
registry-driven, provider-agnostic desktop AI operating system. All unit tests,
typechecks, lint, and the e2e smoke test pass.

---

## 1. Executive summary

The original codebase was a working prototype with a strong UI and a real
Gemini Live voice loop, but it shipped with placeholder synthesis logic, a
browser/dev-server fallback that violates the "desktop only" constraint, unused
security modules, plaintext API keys, unvalidated IPC, and no tool registry,
audit trail, or automated tests.

This refactor delivers:

- **Tool Registry** — full metadata, capability search, execution metrics,
  health tracking, versioning, rollback, enable/disable, SHA-256 signatures.
- **Tool Builder** — end-to-end capability synthesis with a real validation
  pipeline (syntax → static audit → dependencies → sandbox compile →
  automated tests → security review → registration → execution).
- **Provider-agnostic AI layer** — `AiProvider` interface with Gemini Live and
  Grok adapters, swappable at runtime.
- **Sandboxed executor** — isolated-vm execution with memory caps, timeouts,
  and host-API isolation; builtin tools run as permission-scoped host handlers.
- **Security** — OS-encrypted secret vault, IPC firewall wired into every
  handler, allowlisted preload, PII sanitization, audit logging.
- **Desktop-only enforcement** — removed the Vite dev server on port 8080 and
  the WebSocket/browser fallback code.
- **Windows integration** — tray, global hotkey, notifications, clipboard,
  app launching, system info; Windows-correct meeting-mode audio capture.
- **Tests & CI** — 34 headless unit tests, updated CI workflows, and
  production packaging targets (NSIS installer + portable exe).

---

## 2. Issues discovered and resolved

### 2.1 Architecture / constraint violations
| # | Issue | Resolution |
|---|---|---|
| 1 | `scripts/dev-dual.js` started a Vite dev server on port **8080** and launched Electron against `http://127.0.0.1:8080` — a browser/server workflow in a desktop-only product. | Rewritten: compiles main + renderer and launches Electron against bundled files. **No server, no port.** |
| 2 | `src/renderer/utils/browser_bridge.ts` contained a WebSocket client with `ws://localhost:8080/ws` fallback and a reconnect loop — dead code (never imported) that normalized a browser/dev-server architecture. | **Removed.** |
| 3 | Meeting-mode audio capture used `navigator.mediaDevices.getUserMedia` in the **main process** (does not exist there) and ffmpeg with the macOS-only `avfoundation` input on Windows. | Rewritten with Windows `dshow` capture via ffmpeg subprocess, graceful degradation, and honest failure events. |
| 4 | Speaker diarization claimed "started" while merely printing a stub script; on Windows it spawned `python3` which may not exist. | Now probes for a Python runtime + `pyannote.audio` and reports availability honestly. |

### 2.2 Tooling / placeholders
| # | Issue | Resolution |
|---|---|---|
| 5 | Tool synthesis was a single-purpose **live-stream widget** generator; every intent produced an HLS/embed tool, falling back to `https://www.example.com` (a dummy URL). | Rebuilt as a general capability pipeline. Media intents still produce real stream widgets; other intents produce validated capability descriptors. The dummy `example.com` fallback is gone. |
| 6 | Registry search was literally a comment: `// Simulate registry search - tool not found`. | Replaced by real keyword scoring (`ToolRegistry.searchCapability` / `findCapability`), and existing tools are actually **reused**. |
| 7 | Tool registry metadata was a hand-rolled `Map` + `tools.json` with 5 fields. | New `ToolRegistry` with the full metadata contract: id, name, description, category, author, version, permissions, dependencies, entry point, config, execution history, success rate, average execution time, health, last validation date, signature/hash, enabled state, version history. Legacy `tools.json` entries are migrated on first boot. |
| 8 | "Compiled" tools were invoked incorrectly (`compiledFn({})` on an `ivm.Reference`, which cannot be called like a plain function — silently marking tools failed). | New executor invokes via `applySync` (Reference mode) **or** direct call, depending on the isolated-vm build; results are normalized to JSON. |
| 9 | Network device discovery hardcoded `192.168.1.x`. | Auto-detects the real local subnet from `os.networkInterfaces()` and bounds concurrency (48 sockets). |
| 10 | `generate_cad` / `iterate_cad` returned a literal "started asynchronously" stub. | Now queue a **persisted automation task** (recorded in the interaction ledger) and return a real task id; deep CAD execution is documented as requiring an external backend. |

### 2.3 Security
| # | Issue | Resolution |
|---|---|---|
| 11 | `GEMINI_API_KEY` was read straight from `.env` into module singletons; keys persisted in plaintext. | New `SecretStore` uses Electron `safeStorage` (DPAPI on Windows) with env bootstrap; keys are loaded at boot and never written to disk in plaintext. |
| 12 | `ipc_firewall.ts` existed but was **never used** — every `ipcMain.on/handle` was open. | Every IPC handler now goes through `guardedOn`/`guardedHandle`: unknown channels are denied + audited, payloads PII-sanitized (binary channels excluded). |
| 13 | Preload exposed a generic `on(channel, listener)` and stored handlers keyed by `String(listener)` (leaky, unenumerable). | Preload rewritten: channel allowlists for events/sends/invokes, Map-based handler tracking, unknown channels ignored/rejected. |
| 14 | `webviewTag: true` in the renderer (unneeded web-content surface). | Disabled; added `sandbox: true`. |
| 15 | Permission handler allowed `screenCopy` to the renderer. | Restricted to `media`, `audioCapture`, `videoCapture`. |
| 16 | No audit trail anywhere. | New `audit_logger` + `logger.audit()`; every tool build/execution, IPC denial, secret action, and shortcut trigger is recorded. |
| 17 | Generated tools were only "scanned" by string matching; the AST scanner was duplicated between `security.ts` and the orchestrator. | Consolidated: `ToolValidator` runs the AST audit (single implementation), plus sandbox compile and automated tests. |

### 2.4 Reliability / performance / correctness
| # | Issue | Resolution |
|---|---|---|
| 18 | `better-sqlite3` is Electron-ABI only; headless Node tests/CI could not run. | `ToolStore` abstraction: SQLite primary, JSON-file fallback selected automatically. Headless tests and CI now work. |
| 19 | Screen capture: 2 fps native block-hash delta (with JS fallback) — kept, but telemetry/graph wiring hardened. | No functional change; documented. |
| 20 | Reconnect storm risk in the Gemini bridge was largely handled (backoff + jitter); now also gated on a configured key and emits proper state transitions. | Retained and documented; added `setApiKey` for runtime key rotation. |
| 21 | No graceful close-to-tray lifecycle; quitting killed the assistant from the window close button. | Close now hides to tray (standard assistant behavior); tray **Exit** and OS signals perform full shutdown with ordered service teardown. |
| 22 | `agent_projects` was created under `process.cwd()` with no oversight. | Filesystem tools remain sandboxed to that root (path traversal rejected); project root is configurable via `NOVA_PROJECTS_ROOT`. |
| 23 | No global shortcut / notifications / clipboard / system-info capabilities. | Added via `WindowsIntegration` and exposed through firewalled IPC and builtin tools (`clipboard_read/write`, `notify`, `system_info`, `capture_screen`, `run_web_agent`, …). |
| 24 | Root scratch files (`test_*.js`, `electron_*.log`, `rebuild-local*.log`) were committed. | Removed. |

### 2.5 Dead code / duplication
| # | Issue | Resolution |
|---|---|---|
| 25 | `capability_permissions.ts` and `ipc_firewall.ts` were unused. | Firewall now wired in; permissions consolidated into `tool_types.ts` and enforced at execution boundaries. |
| 26 | `encryption.ts` (AES-GCM DB cipher) was unused. | Retained as a documented utility for future at-rest DB encryption; not dead-path removed. |
| 27 | Duplicated AST scanning in `security.ts` + orchestrator. | Single validator path (see #17). |
| 28 | `duplicate tool declarations` were re-appended on every load. | Declarations are rebuilt deterministically from the registry; no duplicates. |
| 29 | Hardcoded `sourceHash: 'test'` on the validation probe collided with the executor's compile cache — validating tool B could run tool A's code. | Probe tools now carry their real SHA-256 source hash. |
| 30 | Loop guards only matched `while(true)` / `for(;;)`, trivially bypassed by `while(1)` or `for(var i=0;;i++)`. | Guards extended to any `while(1|true)`, any empty-condition `for`, `do…while(1|true)`, plus AST-based self-recursion rejection. |
| 31 | Concurrent `ensureCapability` calls clobbered shared builder progress state. | Builder serializes builds through an internal queue. |
| 32 | `before-quit` never awaited the async teardown; claimed graceful shutdown was overstated. | `will-quit` now prevents the default quit, awaits teardown (3 s hard cap), then `app.exit(0)`; `shutdownServices` is idempotent. |
| 33 | `TRIGGER_AUTOMATION` synthesized and registered a tool for *every* command (registry pollution). | Synthesis is now gated on a registry match or automation/media verbs; open-ended requests flow to the model only. |
| 34 | `capability_permissions.ts` and `registerPermissionDefaults()` were dead code. | Removed; permissions are declarative metadata on `ToolDefinition`. |
| 35 | No Python runtime for automation/OCR tooling. | Added `python_runtime.ts` bridge (interpreter discovery, module probing, JSON-over-stdout with timeouts) and `python_info` / `python_ocr` builtin tools that report availability honestly. |

---

## 3. Architectural changes

1. **Orchestrator refactor** — `agent_orchestrator.ts` is now a coordinator:
   builtin tools are registered with metadata + audited host handlers, tool
   calls dispatch through the registry/executor, and synthesis delegates to the
   Tool Builder. No more giant `switch` over fake capabilities.
2. **Registry-driven execution** — every capability (builtin or generated) is a
   registered `ToolDefinition`; the Gemini declarations are derived from the
   registry, so newly built tools are callable by the model immediately.
3. **Provider abstraction** — new `AiProvider` interface + registry. The Tool
   Builder and conversation loop never name a vendor.
4. **Sandbox executor** — dedicated `tool_executor.ts` handles both isolated-vm
   API modes, caches compiles (LRU), records metrics, and maps errors.
5. **Validation pipeline** — dedicated `tool_validator.ts` with the 7-stage
   pipeline (syntax → static audit → size → dependencies → sandbox compile →
   automated tests → permission inference).
6. **Centralized configuration & logging** — `core/config.ts` + `core/logger.ts`.
7. **Hardened IPC** — firewall + sanitized preload + `sandbox:true` renderer.
8. **Secrets & audit** — `secret_store.ts` + `audit_logger.ts`.
9. **Windows integration** — tray, global hotkey, notifications, clipboard,
   launch, system info; Windows-correct meeting audio.
10. **Desktop-only enforcement** — no dev server, no browser fallback code.

## 4. New modules

| Module | Purpose |
|---|---|
| `src/main/core/config.ts` | Centralized runtime configuration |
| `src/main/core/logger.ts` | Structured logging + audit channel |
| `src/main/services/ai_provider.ts` | Provider-agnostic AI layer (Gemini Live, Grok) |
| `src/main/services/tool_types.ts` | Canonical tool metadata/validation types |
| `src/main/services/tool_store.ts` | SQLite/JSON tool persistence |
| `src/main/services/tool_registry.ts` | Production tool registry |
| `src/main/services/tool_validator.ts` | 7-stage tool validation pipeline |
| `src/main/services/tool_executor.ts` | Sandboxed tool execution |
| `src/main/services/tool_builder.ts` | Capability synthesis pipeline |
| `src/main/services/secret_store.ts` | OS-encrypted secrets vault |
| `src/main/services/audit_logger.ts` | Audit trail |
| `src/main/services/windows_integration.ts` | Native Windows capabilities |
| `src/main/services/python_runtime.ts` | Python runtime bridge + OCR/automation tooling |
| `scripts/run-tests.js` | 40 headless unit tests |

## 5. Removed modules / files

| File | Reason |
|---|---|
| `src/renderer/utils/browser_bridge.ts` | Browser/WebSocket fallback — violated desktop-only constraint |
| `scripts/dev-dual.js` (old) | Started a dev server on port 8080 — now serverless launcher |
| `test_binding.js`, `test_dynamic.js`, `test_electron*.js`, `test_globals.js`, `test_main*.js`, `test_path.js`, `test_process.js` | Scratch debugging scripts |

## 6. Behavioral notes

- **`generateToolFromIntent`** (UI + smoke-test entry point) now returns
  `status: 'compiled'` for successfully registered tools; the e2e smoke test
  passes against the new pipeline.
- **`TRIGGER_AUTOMATION`** sends the command to Gemini Live *and* routes it
  through the Tool Builder, so known capabilities (e.g. `list my projects`,
  media streams) execute real tools while open-ended requests are answered
  conversationally.
- **Generated generic tools** are capability descriptors; media intents
  produce live-stream widgets rendered by the HUD.
- **Close-to-tray**: closing the window keeps NOVA resident; use the tray menu
  or `Ctrl+Shift+H` to summon it, and **Exit** to quit.

---

## 7. Build & packaging

### Prerequisites (Windows)
- Node.js 18+ LTS
- Visual Studio 2022 Build Tools (C++ workload, Windows 10/11 SDK)
- Rust toolchain (for the native screen-capture crate)
- Python 3 (optional, for diarization tooling)

### Development
```bash
npm ci                 # installs deps + rebuilds native modules for Electron
npm run dev:dual       # compile + launch Electron (no dev server)
npm run dev            # tsc + vite build + electron .
```

### Verify
```bash
npm run typecheck      # main + renderer TypeScript
npm run build          # compile main + bundle renderer
npm run test:unit      # 34 headless unit tests (registry, validator, executor, builder, providers)
npm run e2e:smoke      # end-to-end tool synthesis smoke test
npx eslint src scripts # lint
```

### Package (Windows)
```bash
npm run electron:package   # electron-builder: NSIS installer + portable exe -> dist_electron/
```
The `build` section in `package.json` is production-ready: `appId`, NSIS
installer (choice of directory, desktop/start-menu shortcuts) **and** a
portable executable, `npmRebuild: true`, `extraResources` carrying
`native_modules`. Add a branded icon by placing `build/icon.ico` (electron-builder
picks it up automatically; the current build uses the default Electron icon).

### Known limitation
`isolated-vm` is excluded from the partial native rebuild because it often
fails to link against Electron's V8 on Windows (unresolved symbols). The sandbox
executor therefore works best when `isolated-vm` is built for the target ABI;
the validator emits a `SANDBOX_UNAVAILABLE` warning and the executor falls back
gracefully. See `docs/BUILD_WINDOWS.md` for the full troubleshooting guide.
