# A.D.A.M. — OLD BACKEND BASELINE

This document captures the **known-working legacy backend** (`src/main/main.ts`
+ `src/main/services/*` + `python/nova_runtime/*`) as the stable baseline that
this reconciliation restores as the ACTIVE production backend. It is written
before/during the merge so the working behavior is preserved and never silently
rewritten.

---

## 1. What the legacy backend is

- **Entry point:** `src/main/main.ts` (Electron main process).
- **Architecture:** a single orchestrator (`AgentOrchestrator`) coordinating AI
  providers, the Tool Registry, Tool Executor and Tool Builder; plus a rich set
  of services. This is the version whose frontend/backend integration is the
  known-good contract.
- **Frontend contract:** `src/shared/ipc_protocols.ts` + `src/main/preload.ts`.
- **Python runtime:** `python/nova_runtime/*` (a persistent stdio worker).

## 2. How it is initialized (startup order)

1. `bootstrapAudit()` / `bootstrapSecrets()` (SecretStore → providers).
2. `registerIpcHandlers()` + `registerWhisperHandlers()` + `initializeWhisper()`.
3. `graphEngine.init(userData)` → boot step 1.
4. `memoryEngine.init(userData)`.
5. `personalityEngine.init(userData)` (form of address = "Sir").
6. Tool registry/executor marked online.
7. `wakeWordDetector.initialize()` + start (Picovoice) → boot step 2.
8. `createWindow()` / `createTray()` / shortcuts / Gemini bridge handlers.
9. Workspace wiring + persisted surface restore.
10. `geminiLiveBridge.connectStream()` → boot step 4 (voice = **Charon**).
11. Ingestors + context + dream mode + specialized modes + telemetry loop.

## 3. IPC contract (the working baseline)

### Backend → Frontend events
- `nova-ipc:boot-lifecycle` — boot steps
- `nova-sys:runtime-state-change` / `nova-sys:runtime-activity`
- `nova-sys:voice-state-change`
- `nova-sys:speech-text-transcribed` (Whisper / Gemini Live partial+final)
- `nova-sys:mic-state-change`
- `nova-sys:telemetry-update` (~1Hz), `nova-ui:context-chip-update`
- `nova-sys:workspace-update`
- `ai-text-token`, `ai-amplitude`, `ai-audio-chunk`, `nova-sys:audio-buffer-flush`
- `agent-progress-update`, `agent-tool-created`, `agent-tool-synthesis-*`,
  `agent-tool-approval-request`
- `nova-sys:gemini-setup-complete`, `wake-word-detected`
- `nova-sys:dream-mode-*`, `nova-sys:mode-changed`

### Frontend → Backend (invoke)
- `nova-act:trigger-automation`, `nova-act:run-task`, `nova-act:run-tool`
- `nova-db:tool-registry-view`, `tool-health-report`, `tool-toggle`,
  `tool-exec-log`, `tool-approve`, `tool-reject`
- `nova-db:list-capabilities`, `memory-search`
- `nova-sys:system-info`, `clipboard-read`, `clipboard-write`, `notify`
- `nova-db:audit-recent`, `get-runtime-state`, `get-boot-state`
- `nova-act:mic-toggle`, `nova-db:mic-diagnostic`, `mic-discover`,
  `mic-set-muted`, `get-mic-state`
- `nova-db:workspace-list`, `nova-act:workspace-close`, `workspace-open-url`
- `nova-db:get-knowledge-nodes`, `get-ledger-entries`, `vector-search`,
  `nova-labs:life-replay-timeline`, `intent-prediction`

### Frontend → Backend (send)
- `user-audio-chunk`, `user-speaking-active`, `camera-frame`
- `nova-sys:mic-capture-active`, `mic-capture-error`
- `nova-ui:hud-visibility-req`, `window-minimize/maximize/close`

## 4. Providers (working)

- **Gemini Live** — conversational/audio head, voice **Charon** (via
  `NovaConfig.ai.liveVoice`). Tool calls routed through the orchestrator.
- **Groq** — reasoning/planning/engineering/tool-synthesis (via
  `taskRouter` / `aiProviderRegistry`). Provider ID `groq`.
- **Local Whisper** — low-latency streaming transcription fallback.

## 5. Working systems (must remain intact)

| System | File(s) | Behavior |
|---|---|---|
| Tool Registry | `tool_registry.ts`, `tool_store.ts`, `tool_types.ts` | register/lookup/search/version/rollback/health, SQLite + JSON fallback |
| Tool Forge | `tool_forge.ts` | real Python tool generation, template fast-path, sandbox test, repair loop, production run |
| Tool Builder | `tool_builder.ts` | capability reuse-or-build, stream widget path, approval gate |
| Tool Executor | `tool_executor.ts` | sandbox worker (isolated-vm), wall-clock kill, builtin dispatch, python tool production run |
| Tool Validator | `tool_validator.ts` | sandbox compile, security/perms/loop/recursion checks, permission inference |
| Task Runner | `task_runner.ts` | capability match + autonomous execution trace |
| Autonomous Execution | `autonomous_execution_engine.ts` | plan → execute → verify → recover |
| Memory Engine | `memory_engine.ts` | semantic memory, identity, facts, consolidation, secret scrubbing |
| Personality Engine | `personality_engine.ts` | "Sir" address, factual presentation, voice system instruction |
| Mic Manager | `mic_manager.ts` | honest mic state machine + Python diagnostic |
| Python Runtime | `python_runtime.ts` | persistent stdio worker, scrubbed env, restart/backoff |
| Workspace | `workspace_manager.ts` | typed surfaces, persistence, workspace-first |
| AI Provider | `ai_provider.ts` | Gemini Live + Groq + registry + priority |
| Context Engine / Dream / Modes | `context_engine.ts`, `dream_mode.ts`, `specialized_modes/*` | foreground chips, dream, meeting/coding/creative |
| Windows Integration | `windows_integration.ts` | shortcuts, notify, clipboard, system info |
| IPC Firewall | `ipc_firewall.ts` | channel allow/deny + sanitization |
| Audit | `audit_logger.ts` | audit trail |
| Secret Store | `secret_store.ts` | encrypted vault |

## 6. Regression suite

`scripts/run-tests.js` (headless, requires built `dist/main`). Covers tool
registry/validator/executor/builder/forge, python runtime, AI provider,
task router, runtime state, mic manager, builtin tools, task runner,
workspace manager, memory engine, personality engine, voice/Charon config,
permission enforcement, execution ledger, python worker.

## 7. What must remain unchanged

- The legacy Electron main entry and its IPC/event contract.
- Existing service implementations (no rewriting/refactoring).
- The `Charon` voice, `Groq` provider, `Gemini Live` head.
- The frontend visual contract.

## 8. Known environment-dependent test

- `[tool_forge] forge template writes real .py + tests ... Window Insight` uses
  `ctypes.windll.user32.GetForegroundWindow` (Win32). It **cannot pass on a
  Linux sandbox**; it is a Windows-only test that must be verified by Codex on a
  Windows host. It is not a regression introduced by this merge.
