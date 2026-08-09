# NOVA Genesis — Architecture

NOVA Genesis is an **Electron-only desktop AI operating system**. There is no
browser UI, no localhost server, no web dashboard. The renderer is a bundled
React shell; everything else runs in the Electron main process, with native
Windows integration layered on top.

```
┌─────────────────────────────────────────────────────────────┐
│                        Electron Main                        │
│                                                             │
│  NOVA Core (orchestrator) ───────────────────────────────┐  │
│   ├── Tool Registry (SQLite/JSON)   ◄── Tool Builder     │  │
│   ├── Tool Executor (worker process) ◄── Tool Validator   │  │
│   ├── Ai Provider Registry (Gemini/Grok, swappable)      │  │
│   ├── Gemini Live Bridge (voice conversation)            │  │
│   ├── Memory Engine (graph + ledger + embeddings)        │  │
│   ├── Windows Integration (clipboard/notify/shortcuts)   │  │
│   ├── Ingestors (screen, voice/VAD, wake word, context)  │  │
│   ├── Secret Store (safeStorage vault)                   │  │
│   └── Audit Logger + structured Logger                   │  │
│                                                             │
│  IPC (firewalled + PII-sanitized)   ◄── preload allowlist  │
└─────────────────────────────────────────────────────────────┘
                            │
                    ┌───────▼────────┐
                    │  React Renderer │  (HUD, orb, waveform,
                    │  (bundled,      │   telemetry, transcripts)
                    │   no network)   │
                    └────────────────┘
```

## Division of responsibility

| Layer | Responsibility |
|---|---|
| Electron | UI shell, window management, IPC, tray, notifications, global shortcuts |
| Node/TypeScript (main) | Orchestration, tooling, AI execution, vision plumbing, filesystem sandbox, speech pipeline, OS integration |
| Native (Rust) | Screen block-hash delta detection (`native_modules`) |
| Renderer (React) | Presentation only — no privileged capability |

## Orchestration pipeline

```
User Request
   │
   ▼
NOVA Core (AgentOrchestrator)
   │
   ▼
Intent Analysis (builtin tool dispatch + Gemini Live)
   │
   ▼
Task Planner (Tool Builder: ensureCapability)
   │
   ├── Capability Registry Lookup
   │      ├── YES ──► Load Existing Tool ──► Execute ──► Log ──► Update Registry
   │      └── NO  ──► Generate New Tool
   │                    ├── Static Validation (AST security audit)
   │                    ├── Dependency Validation
   │                    ├── Automated Tests (sandboxed)
   │                    ├── Security Review
   │                    ├── Register Tool
   │                    ├── Load Tool
   │                    ├── Execute Task
   │                    └── Log Results ──► Update Registry
```

## Modules

### Core
| Module | Purpose |
|---|---|
| `src/main/core/config.ts` | Centralized configuration (paths, timeouts, model names, thresholds). Every tunable lives here. |
| `src/main/core/logger.ts` | Structured, leveled logger with file rotation and an `audit()` channel. |

### AI
| Module | Purpose |
|---|---|
| `src/main/services/ai_provider.ts` | Provider-agnostic `AiProvider` interface + `AiProviderRegistry`. Ships `GeminiLiveProvider` (live socket + REST fallback) and `GrokProvider` (xAI REST). Providers are swappable via `NOVA_PROVIDER_PRIORITY`. |
| `src/main/services/gemini_live_bridge.ts` | WebSocket session to Gemini Live: audio in/out, transcriptions, tool calls, heartbeat, backoff reconnect, barge-in cancellation. |

### Tooling
| Module | Purpose |
|---|---|
| `src/main/services/tool_types.ts` | Canonical `ToolDefinition` metadata + validation/execution types. |
| `src/main/services/tool_store.ts` | Persistence: SQLite (better-sqlite3) with a transparent JSON fallback for headless/CI. |
| `src/main/services/tool_registry.ts` | Single source of truth for capabilities: full metadata, capability search, execution metrics, success rate, health, versioning, rollback, enable/disable, SHA-256 signatures, legacy migration. |
| `src/main/services/tool_validator.ts` | Validation pipeline: syntax (acorn), static security audit (AST), size limits, dependency validation, sandbox compile, automated unit tests, permission inference. |
| `src/main/services/tool_executor.ts` | Sandboxed execution in a dedicated child process: spawn/reuse, JSON-lines IPC, hard wall-clock SIGKILL with respawn, builtin-handler dispatch, metrics recording. |
| `src/main/services/sandbox_worker.ts` | Worker-process sandbox runtime (spawned by the executor): isolated-vm compile/cache with a `vm` fallback, internal watchdog self-termination, no host APIs, scrubbed environment. |
| `src/main/services/tool_builder.ts` | End-to-end synthesis: registry lookup → code generation (provider-agnostic) → validation → tests → registration → activation → execution → audit. Emits UI progress events. |
| `src/main/services/agent_orchestrator.ts` | NOVA Core: builtin tools (filesystem sandbox, projects, clipboard, notifications, system info, screen capture, IoT/manufacturing HTTP controls, task queue), Gemini declarations, tool-call dispatch through the registry. |

### Memory
| Module | Purpose |
|---|---|
| `src/main/db/sqlite_adapter.ts` | Interaction ledger (voice loops, tool executions, automation triggers) in WAL SQLite. |
| `src/main/db/graph_engine.ts` | Knowledge graph (nodes/edges) + in-memory HNSW-style vector index for semantic search. |
| `src/main/services/context_engine.ts` | Foreground-window context chips via a persistent PowerShell session. |
| `src/main/services/life_replay.ts`, `intent_forecaster.ts`, `spatial_memory.ts`, `dream_mode.ts` | Timeline replay, Markov-chain intent prediction, window-bounds memory, nightly consolidation. |

### Security
| Module | Purpose |
|---|---|
| `src/main/services/secret_store.ts` | OS-encrypted secret vault (Electron `safeStorage`), env bootstrap, never persists plaintext. |
| `src/main/utils/security.ts` | AST security scanner (blocked keywords, dangerous modules/functions, loop detection), isolated-vm compatibility checks. |
| `src/main/services/ipc_firewall.ts` | Channel allowlist + PII sanitization for every IPC handler. |
| `src/main/preload.ts` | Allowlisted, leak-free IPC bridge (Map-based handler tracking, channel allowlists). |
| `src/main/services/audit_logger.ts` | Audit trail (action/outcome/details) in SQLite with JSONL fallback. |
| `src/main/services/pii_sanitizer.ts` | Regex-based redaction (cards, SSNs, API keys, secrets). |

### Windows integration
| Module | Purpose |
|---|---|
| `src/main/services/windows_integration.ts` | Clipboard, notifications, global shortcuts, app launching, system info. |
| `src/main/services/python_runtime.ts` | Python backend bridge: persistent JSON-RPC stdio worker (python/nova_runtime) with request timeouts, restart/backoff, scrubbed env; one-shot script fallback. Powers OCR, filesystem and automation tooling. |
| `src/main/services/task_router.ts` | Intent classifier + provider router: routes reasoning/engineering/planning work to Grok (when configured), conversation/media to the primary provider. |
| `src/main/services/memory_engine.ts` | Long-term semantic memory: pluggable embedders (Gemini + local n-gram), importance + exponential decay, dual-source retrieval, JSON persistence. |
| `src/main/services/builtin_tools.ts` | Builtin tool registration (23 tools) + LAN device discovery/control behind a strict host & port allowlist. |
| `python/nova_runtime/` | Python backend package: asyncio stdio JSON-RPC worker, sandboxed filesystem, OCR + automation capability-gated services, venv bootstrap. |
| `src/main/ingestors/screen_capturer.ts` | Screen delta detection (Rust block hashes with JS fallback). |
| `src/main/ingestors/voice_processor.ts` | Silero VAD speech-state machine with amplitude fallback. |
| `src/main/ingestors/wake_word_detector.ts` | Porcupine wake word with RMS fallback ring buffer. |
| `src/main/services/specialized_modes/` | Meeting / live-coding / creative mode detection; Windows-correct ffmpeg audio capture; honest diarization availability probe. |

## Tool Builder details

The builder is **provider-independent**. Code generation calls
`aiProviderRegistry.primary()`; whichever model is configured (Gemini, Grok, or
a future provider) answers the same "write a single JavaScript function"
prompt. When no provider is configured, a deterministic local generator
produces a validated capability function.

Generated tools are pure functions executed in a **dedicated worker process**
(`sandbox_worker.js`) that has **no access to the host**: no `process`,
`require`, `eval`, `fs`, or network, and no API keys (the parent spawns it with
a scrubbed environment). Host and worker exchange JSON values only over stdio.
Every invocation is guarded by a hard wall-clock deadline: when a tool exceeds
its budget — even with a synchronous infinite loop no in-process timer can
preempt — the entire worker process is terminated and respawned on the next
request. Built-in tools (filesystem, clipboard, network controls) run as
audited host handlers that are individually permission-scoped.

### Validation pipeline (per generated tool)
1. **Syntax** — acorn parse must succeed.
2. **Static audit** — AST walk rejects dangerous functions/modules and loop patterns.
3. **Size** — source capped (`NOVA_TOOL_MAX_BYTES`, default 64 KB).
4. **Dependencies** — any `import`/`require` is a validation error inside the sandbox.
5. **Sandbox compile** — must compile and evaluate to a callable function.
6. **Automated tests** — invoked with sample contexts; must not throw, must return an object, must expose `success`.
7. **Permission inference** — network/clipboard/notification usage is derived statically and attached to the tool.

### Registry lifecycle
`register → enable → execute → recordExecution → health (unknown → healthy/degraded/unhealthy)`
`publishVersion → (source change) → rollback → previous version`
`remove → audit event`

## Memory architecture
- **Interaction ledger** — every voice loop, tool execution and automation trigger is persisted (PII-sanitized).
- **Knowledge graph** — nodes (`entity/concept/project/file/tool/session`) and typed edges, each embedded into a 128-dim vector index for semantic recall.
- **Project memory** — sandboxed `agent_projects` workspace manipulated through filesystem tools.
- **Tool memory** — the registry itself: success rates, average latency, health, last validation date.
- **Preferences & execution history** — telemetry, ledger queries, and life-replay timelines.

## Security model
- Renderer is fully sandboxed (`sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`, `webviewTag: false`).
- Preload exposes only allowlisted channels; unknown channels are ignored.
- Main-process IPC is firewalled: unknown channels are denied and audited; payloads are PII-sanitized.
- Generated code runs in a dedicated worker process with a memory cap, execution timeout, and a hard wall-clock SIGKILL; no host APIs, scrubbed environment. Static analysis also rejects `while(1)`/`for(;;)` variants and self-recursion as defense in depth. Process isolation closes the synchronous-runaway-loop non-preemption gap.
- API keys live in an OS-encrypted vault and are bootstrapped from `.env` on first run.
- Every security-relevant action is written to the audit trail.

## Configuration
All runtime configuration is centralized in `src/main/core/config.ts` and can be
overridden with environment variables:

| Variable | Default | Purpose |
|---|---|---|
| `GEMINI_API_KEY` | — | Gemini Live + REST codegen |
| `GROK_API_KEY` | — | Grok provider (swappable) |
| `PICOVOICE_ACCESS_KEY` | — | Wake word (Porcupine) |
| `NOVA_PROVIDER_PRIORITY` | `gemini,grok` | Provider selection order |
| `NOVA_SANDBOX_MEMORY_MB` | `64` | Sandbox memory cap |
| `NOVA_TOOL_TIMEOUT_MS` | `2000` | Sandbox execution timeout |
| `NOVA_TOOL_WORKER` | `true` | Process-isolated tool execution (set `false` to disable sandboxed execution entirely) |
| `NOVA_TOOL_WORKER_GRACE_MS` | `1000` | Extra budget before the worker is SIGKILLed |
| `NOVA_TOOL_MAX_BYTES` | `65536` | Generated source cap |
| `NOVA_LOG_LEVEL` | `info` | Logger verbosity |
| `PICOVOICE_FALLBACK_THRESHOLD` | `1500` | RMS wake-word threshold |

## Startup sequence
1. `dotenv` load → crash guards installed.
2. Audit logger + file logger configured.
3. Secret store bootstraps API keys into the runtime and vault.
4. Graph engine + ledger open (WAL SQLite).
5. Wake word detector initializes (Porcupine or RMS fallback); voice pipeline wired.
6. Window + tray + global shortcut (`Ctrl+Shift+H`) created.
7. Gemini Live bridge connects (exponential backoff, heartbeat, stale-socket kill).
8. Ingestors (screen, context), dream mode daemon, and specialized-mode detectors start.
9. IPC handlers registered behind the firewall.
10. Telemetry stream (1 Hz) and barge-in interruption wired.

## Shutdown sequence
`before-quit/SIGINT/SIGTERM → stop ingestors → disconnect bridge → close registry/ledger/graph/audit → close logger`. Close-to-tray keeps the assistant resident; tray **Exit** performs a full quit.

## Design decisions & limitations
- **Worker-process isolation** — the executor runs every generated tool in a
  dedicated child process (`sandbox_worker.js`) with a hard wall-clock kill.
  A synchronous runaway loop cannot be preempted by any in-process timer or
  by isolated-vm's direct-call mode, but it cannot survive the parent's
  SIGKILL of the whole worker; the worker is respawned on the next request.
  This  closes the non-preemption gap. Isolation is always-on by default
  (`NOVA_TOOL_WORKER`); disabling it disables sandboxed execution entirely —
  there is no in-process fallback because it cannot enforce the deadline.
  Requests to one worker are processed serially; a slow tool can push a later
  request toward its own wall-clock deadline before it runs, which is bounded
  by that deadline and by the kill. The worker ships as a plain file in the
  packaged app (`asar: false`), so the spawned child always resolves it.
- **`generate_cad` / `iterate_cad`** queue persisted automation tasks; executing
  a full CAD backend is out of scope and requires an external service.
- **Diarization** probes for `pyannote.audio` and reports availability honestly
  instead of faking results.
- **Generic (non-media) generated tools** are capability descriptors whose
  deeper behavior is delegated to the conversational model; media intents
  produce live-stream widgets used by the HUD.
