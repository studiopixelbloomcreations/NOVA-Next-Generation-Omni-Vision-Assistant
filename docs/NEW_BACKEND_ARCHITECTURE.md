# A.D.A.M. — New Backend Architecture

> **Status: ACTIVE.** This document describes the New Backend (`New Backend/`)
> that is now the only active backend of the application. The runtime AI
> identity is **A.D.A.M. (Autonomous Digital Analytical Mind)**, wake word
> **ADAM**, voice **Charon**. The repository name and the existing frontend
> keep historical "NOVA / NOVA Genesis" references; the RUNTIME identity is
> A.D.A.M. The previous backend (`src/main/main.ts` + `src/main/services/*`)
> is **LEGACY — DISABLED** and retained only for reference/rollback. The
> frontend is **UNCHANGED**.

---

## 1. Guiding Principles

The New Backend was rebuilt from zero so the existing NOVA UI feels connected to
a genuinely autonomous desktop AI. It is **not** a chatbot, a tool-calling
wrapper, a deterministic intent router, or a fake autonomous agent.

1. **Every major responsibility has its own engine.** No monolithic controller.
2. **NOVA is the orchestrator.** The user supplies a goal; NOVA supplies the
   implementation (which tools, which agents, which sources, which workspace,
   how to verify, how to save).
3. **No mocks, no placeholders.** Missing capabilities are **forged** — real
   Python source + real tests, validated in an isolated sandbox, registered,
   executed, verified, and persisted.
4. **The sandbox tests the tool; the real machine executes the validated tool.**
5. **Never fabricate success.** Completion is only claimed after independent
   verification.
6. **Security boundaries are never removed to make autonomy easier.**
7. **Providers are interchangeable.** Groq is the reasoning/coding head; Gemini
   Live is the conversational/voice head (voice = **Charon**). No Grok/xAI.

The New Backend borrows the **concepts** (not the implementation) of the
ADA-SI Forge methodology: separate planning from forging, a dedicated tool
creator, generated source + generated tests, a validation pipeline, bounded
iterative repair, persistent tool storage, tool rediscovery, and
execution/verification separation. It implements NOVA's own Electron-only +
Python-runtime + local-desktop-execution version of those concepts. There is no
localhost server, no browser backend, no HTTP runtime.

---

## 2. Directory Layout

```
New Backend/
  package.json                 # ESM build (Node tests/CLI) + CJS build (Electron)
  tsconfig.json                # ESM -> dist/
  tsconfig.cjs.json            # CJS -> dist-cjs/ (required by Electron main)
  python_runtime/
    nova_runtime/
      __main__.py              # one-shot JSON-RPC entry (sandbox-test, tool-run,
                               #   system-info, fs-largest, fs-list, check-syntax)
      sandbox.py               # isolated temp-dir test runner (scrubbed env, timeout)
      runtool.py               # production run(params) loader
      validate.py              # AST security scan (banned imports/calls, entry point)
      system.py                # host/OS introspection
      fs.py                    # directory analysis (largest files, listing)
  scripts/
    demo.mjs                   # autonomous end-to-end CLI demo
    write_cjs_pkg.mjs          # marks dist-cjs as CommonJS
  src/
    index.ts                   # NovaBackend facade (public entry; lifecycle wiring)
    electron_adapter.ts        # maps backend onto the EXISTING frontend IPC contract
    contracts/domain.ts        # canonical typed domain models
    contracts/ipc.ts           # frontend-facing IPC channel contract
    core/config.ts  logger.ts  errors.ts
    lifecycle/LifecycleEngine.ts
    persistence/storage.ts  tool_library.ts  execution_ledger.ts  settings_store.ts
    security/secret_store.ts  sanitizer.ts  path_guard.ts  env_scrubber.ts
    telemetry/TelemetryEngine.ts
    providers/ProviderTypes.ts  ProviderRegistry.ts  GroqProvider.ts  GeminiProvider.ts
    reasoning/AgentSelector.ts  PromptEngine.ts
    input/InputEngine.ts
    intent/IntentEngine.ts
    memory/MemoryEngine.ts
    environment/EnvironmentEngine.ts
    capability/CapabilityDiscoveryEngine.ts
    planning/PlanningEngine.ts
    forge/ToolForge.ts  Design.ts  NamingEngine.ts
    validation/ValidationEngine.ts
    testing/ToolTestingEngine.ts
    execution/ExecutionEngine.ts  PythonRuntimeBridge.ts
    verification/VerificationEngine.ts
    recovery/RecoveryEngine.ts
    voice/VoiceEngine.ts
    workspace/WorkspaceEngine.ts
    tools/BuiltinTools.ts
    orchestration/NovaAgent.ts   # master execution loop
    tests/                       # unit + integration (end-to-end real pipelines)
```

Electron entry (in the repo root):

```
src/main/nova2_main.ts   # ACTIVE Electron main — boots New Backend only
src/main/main.ts         # LEGACY — DISABLED (retained, not the entry point)
```

---

## 3. Engine Responsibilities

| Engine | Responsibility |
|---|---|
| **Input Engine** | Accepts Whisper transcripts, typed requests, multimodal and system-triggered inputs; normalizes into a `RequestEnvelope` (requestId, timestamp, source, transcript, language, wakeWordDetected, workspace/task/memory/env context). |
| **Intent Engine** | AI-assisted intent classification (falls back to deterministic keyword classification) into `StructuredIntent` (conversational, informational, workspace, computer_task, multi_step_task, engineering_task, tool_creation, system_task, background_task). |
| **Memory Engine** | Persistent local memory (identity, preferences, projects, workflows, facts, task/tool history). Relevant retrieval (ranked, bounded) — never a full-database dump. Secrets are scrubbed before storage. |
| **Environment Engine** | Builds an `EnvironmentSnapshot` (platform, CPU, RAM, hostname, cwd, workspace/tools dirs, running apps/processes, network, Python availability). |
| **Capability Discovery Engine** | Semantic search across ALL capabilities (built-ins, Python tools, persistent generated tools). Returns ranked `CapabilityMatch` with confidence, health, latency, success rate, version. If nothing satisfies → Forge. |
| **Planning Engine** | Produces a machine-executable `ExecutionPlan` (steps, dependencies, required capabilities, expected results, verification strategy, fallback strategies, timeout, risk level). AI-assisted with deterministic recovery. |
| **Agent Selection Engine** | Picks the strongest available provider for each role (reasoning, coding, planning, conversational) — never hardcodes one model. Groq preferred for reasoning/coding; Gemini for conversation. |
| **Prompt Engine** | The **only** place prompts are built. Constructs prompts from goal, environment, memory, capabilities, tool contracts, platform, security constraints, output schema, verification/failure strategy. For tool creation it explicitly demands real Python source + real tests, never fake success. |
| **Tool Forge** | Generates real Python tools (design → source + tests → static validation → isolated sandbox test → bounded repair → registration → persistence). Template fast-path for known harmless capabilities. |
| **Validation Engine** | Python syntax, AST/import scan, dependency validation, permission validation, forbidden-API checks, resource checks, output schema, manifest, checksum. Verdicts PASS / WARN / BLOCK (BLOCK prevents execution). |
| **Tool Testing Engine** | Runs generated tests in an **isolated sandbox** (temp-dir subprocess, scrubbed env, hard timeout). Sandbox ≠ production. |
| **Execution Engine** | Executes validated tools in **production** through the real Python runtime. Built-ins are audited host handlers. Records health/success-rate. |
| **Verification Engine** | Pluggable verifiers; independent verification of outcomes (filesystem, file, directory-analysis, workspace). An AI verifier is optional. A model statement is never proof by itself. |
| **Recovery Engine** | Classifies failures and escalates: retry → alternative strategy → alternative tool → repair/create tool → restart worker → replan. Bounded; never repeats the same failed action indefinitely. |
| **Lifecycle Engine** | Deterministic startup (9 ordered steps) and graceful shutdown (reverse order, no zombie workers). |
| **Telemetry Engine** | Central structured metrics (request/planning/provider/tool/forge/sandbox/verification latency, success rate, retries). |
| **Workspace Engine** | Workspace-first presentation (web, video, image, pdf, file, note, news, tool-result, code surfaces). Content stays inside NOVA unless explicitly external. |
| **Voice Engine** | Voice lifecycle state machine (wake, listening, reasoning, speaking, barge-in). Drives the existing voice surface; Charon + Gemini Live for output, Whisper for transcription. |

---

## 4. Data Flow — The Master Execution Loop

```
USER
 │
 ▼
INPUT ENGINE  ── normalize ──► RequestEnvelope
 │
 ▼
INTENT ENGINE ──► StructuredIntent
 │
 ▼
MEMORY RETRIEVAL ──► relevant memories
 │
 ▼
ENVIRONMENT OBSERVATION ──► EnvironmentSnapshot
 │
 ▼
CAPABILITY DISCOVERY ──► ranked CapabilityMatch[]
 │
 ▼
PLANNING ENGINE ──► ExecutionPlan
 │
 ▼
AGENT SELECTION ──► strongest provider per role
 │
 ▼
PROMPT ENGINE ──► structured prompt
 │
 ▼
EXECUTION PLAN  ── per step:
 │   existing tool? ── yes ──► Execution Engine ──► Verification ──► next
 │   no ──► TOOL FORGE
 │            │  generated Python source + tests
 │            ▼
 │         VALIDATION  (PASS/WARN/BLOCK)
 │            ▼
 │         ISOLATED SANDBOX TEST
 │            │  fail ──► REPAIR (bounded) ──► retest
 │            │  pass ▼
 │            ▼
 │         REGISTRATION + ACTIVATION
 │            ▼
 │         PRODUCTION EXECUTION (real machine)
 │            ▼
 │         VERIFICATION
 │            │  fail ──► RECOVERY / REPLAN
 │            ▼
 │         continue / complete
 │
 ▼
TASK COMPLETION  ──► MEMORY UPDATE ──► OUTPUT ENGINE ──► Gemini Live + Charon
```

`NovaAgent.run()` orchestrates this loop and writes an `ExecutionLedgerEntry`
(requestId/taskId/executionId, plan, agent, steps, verification, retries,
errors, latency, final state). The ledger is also the **duplicate-prevention
barrier** — one user request cannot execute twice because Gemini and Whisper
both emitted the same intent.

---

## 5. Provider Roles

| Provider | Role | Notes |
|---|---|---|
| **Groq** | Reasoning / planning / engineering / tool creation | Primary coding + reasoning agent. No Grok/xAI. |
| **Gemini Live** | Conversational + audio output (voice = **Charon**) | Voice head, streaming transcription display. |
| **Gemini REST** | Coding/reasoning fallback when Groq is unavailable | Fallback only. |

The **Agent Selection Engine** (in `ProviderRegistry`) scores candidates by role
fit, model quality, context window, reliability, latency and configured
priority — it does **not** hardcode a single model. The **SecretStore** holds
API keys; they are never injected into prompts, memory, or subprocess
environments (see Security).

---

## 6. Forge Lifecycle

Inspired by the ADA-SI Forge methodology, implemented NOVA-native.

```
MISSING CAPABILITY
  ▼
TOOL SPECIFICATION (from request / plan step)
  ▼
AGENT SELECTION (coding agent — Groq)
  ▼
PROMPT ENGINE (demands REAL Python source + REAL tests, no fake success)
  ▼
GROQ generates ForgeDesign {displayName, technicalId, description, category,
                            capabilities, permissions, dependencies,
                            pythonSource, testSource}
  ▼
ARTIFACTS WRITTEN: tools/<technicalId>/tool.py, manifest.json, requirements.txt,
                   tests/test_tool.py, README.md   (+ sha256 sourceHash)
  ▼
VALIDATION ENGINE  (syntax + AST + deps + permissions + schema + checksum)
  │  BLOCK ──► fail honestly (no registration)
  ▼
ISOLATED SANDBOX TEST  (temp dir, scrubbed env, hard timeout)
  │  FAIL ──► REPAIR ENGINE (send failure back to coding agent, generate
  │           corrected source, retest; bounded by NOVA2_FORGE_REPAIR_ATTEMPTS)
  │  PASS ▼
  ▼
REGISTRATION  (ToolLibrary upsert; NamingEngine guarantees unique human name
               and stable technicalId; no duplicates — session cache + search)
  ▼
ACTIVATION + PRODUCTION EXECUTION (real machine, through Python runtime)
  ▼
VERIFICATION (independent verifier)
  ▼
PERSISTENCE (survives restart; rehydrated on startup, checksum-verified)
```

**Template fast-path:** known harmless capabilities (e.g. "largest files in a
directory") have a reviewed, real Python template so the Forge is never a dead
end when no AI provider is configured. This is not a mock — it is real source
with real tests, executed and verified.

---

## 7. Sandbox Lifecycle vs Production

```
ISOLATED SANDBOX (validation only)          PRODUCTION (real execution)
─────────────────────────────               ─────────────────────────────
temp dir, copies of tool.py+test            tools/<id>/tool.py on disk
scrubbed env (no secrets)                   real Windows machine
hard wall-clock timeout                      registered tool, real params
synthetic inputs only                       real user-requested target
never touches the real system               the actual action (screenshot,
                                                file, launch, analysis)
```

The sandbox **tests the tool**; the real machine **executes the validated tool**.
Production never runs untested code; the sandbox never runs production actions.

---

## 8. Tool Persistence & Rediscovery

- Tools live on disk under `tools/<technicalId>/` (source, manifest, tests,
  requirements, README).
- **Startup hydration:** scan `tools/` → read manifests → verify checksums →
  validate metadata → register → index → available for reuse.
- Existing tools are **reused**, never recreated. `ToolForge` searches the
  library first (semantic) and keeps a session cache to prevent duplicate
  forging on retry/repair.
- The `ToolLibrary` persists metadata (incl. execution history, health,
  success rate) across restarts; rehydration is idempotent (one tool per
  `technicalId`).

---

## 9. Verification Lifecycle

1. Execute a tool / step.
2. Run an independent verifier registered for the outcome type (filesystem,
   file-exists, directory-analysis, workspace state).
3. If inconclusive and an AI verifier is available, ask it to verify
   **without inventing evidence**.
4. Only a passing independent check marks the step verified.
5. `VerificationEngine` never treats "tool returned success" as proof.

---

## 10. Recovery Lifecycle

- Every failure is classified: `tool_error | dependency_error | timeout |
  permission | environment_mismatch | network_failure | application_failure |
  verification_failure | malformed_output | provider_unavailable`.
- `RecoveryEngine.decide()` returns an escalation:
  `retry → alternative_strategy → alternative_tool → repair_tool →
  create_tool → restart_worker → replan`.
- Bounded by `maxRetriesPerStep`; NOVA never repeats the same failed action
  indefinitely, and only reports failure after strategies are exhausted —
  then it states what was attempted, what failed, why, and what remains
  unavailable. It never fabricates completion.

---

## 11. Memory Lifecycle

- Memory stores identity, preferences, projects, workflows, task history, tool
  knowledge, workspace context, conversation context.
- Before planning, relevant memories are retrieved (ranked, bounded) and
  injected into context — not a full dump.
- After a completed task, the interaction + tool knowledge are recorded.
- Secrets are scrubbed (`PiiSanitizer`) before anything is stored.
- API keys live only in the encrypted `SecretStore`.

---

## 12. Voice Lifecycle

```
IDLE ──wake ("NOVA")──► LISTENING ──utterance start──► LISTENING
  ▲                        │ utterance end
  │                        ▼
  └──speak complete── PROCESSING ──► REASONING ──► SPEAKING
  barge-in (user speaks during SPEAKING) ──► interrupt ──► LISTENING
```

- Wake word **NOVA**; low-latency streaming transcription via local Whisper;
  Gemini Live remains the conversational output layer; voice = **Charon**.
- On `utterance_end`, finalize immediately (no unnecessary waiting).
- **Barge-in:** if NOVA is speaking and the user says NOVA or begins a new
  utterance, current output is interrupted, user audio is captured, transcribed
  and processed — the user never waits for NOVA to finish talking.
- The `VoiceEngine` drives the existing voice surface; the UI is untouched.

---

## 13. Startup & Shutdown

### Startup (LifecycleEngine — ordered, never claims READY prematurely)
1. Configuration + Secret Store
2. Python Runtime Probe
3. Tool Library Hydration + Health
4. Memory Engine
5. Environment Engine
6. Provider Initialization
7. Voice Engine
8. Capability Index
9. Orchestrator → READY

### Shutdown (reverse order)
Stop accepting new tasks → finish/cancel active tasks → flush telemetry →
persist memory → persist registry → stop Python worker → close provider
sessions → close database → Electron shutdown. No zombie Python workers, no
orphaned subprocesses.

---

## 14. Frontend IPC Contract (unchanged UI)

The New Backend wires onto the **existing** `src/shared/ipc_protocols.ts`
channels via `electron_adapter.ts`. The renderer and its components are not
modified. Backend state is pushed on the existing event channels and queries
answer through the existing invoke channels:

| Direction | Channel(s) |
|---|---|
| Request in | `nova-act:trigger-automation`, `nova-act:run-task`, `nova-act:run-tool` |
| Capabilities | `nova-db:list-capabilities`, `nova-db:tool-registry-view`, `nova-db:tool-health-report`, `nova-db:tool-exec-log`, `nova-db:tool-toggle` |
| Memory | `nova-db:memory-search` |
| System | `nova-sys:system-info` |
| State | `nova-db:get-runtime-state`, `nova-db:get-boot-state` |
| Workspace | `nova-db:workspace-list`, `nova-act:workspace-close`, `nova-act:workspace-open-url`, push `nova-sys:workspace-update` |
| Events (push) | `nova-sys:runtime-state-change`, `nova-sys:runtime-activity`, `nova-sys:speech-text-transcribed`, `nova-sys:voice-state-change`, `ai-text-token`, `ai-amplitude`, `ai-audio-chunk`, `agent-progress-update`, `agent-tool-created`, `agent-tool-synthesis-*` |
| Additions (backward-compatible) | `nova2:ping`, `nova2:intent`, `nova2:plan`, `nova2:capabilities`, `nova2:telemetry`, `nova2:memory`, `nova2:activity` |

The `nova2:*` block is strictly additive and never required by the UI.

---

## 15. Security Model

- **Encrypted SecretStore** (AES-256-GCM). Keys never reach prompts, memory, or
  child-process environments (`scrubEnv`).
- **PathGuard** sandbox: tool-generated paths may only resolve inside the tools
  root or Desktop/Documents/Downloads; escapes are hard BLOCKs.
- **Validation Engine** blocks generated code using banned imports/calls
  (subprocess, socket, ctypes, os.system, eval/exec, ...).
- **Sandbox** for tests: temp dir, scrubbed env, hard timeout.
- **Permissions:** generated tools may not request `child-process`/`native-module`;
  unrestricted fs-write is denied.
- **Timeouts, resource limits, audit logs, checksums, versioning, rollback** are
  enforced across execution.
- **No credential extraction / privilege escalation / destructive bypasses.**
- Ordinary authorized desktop tasks execute **autonomously** (open Calculator,
  screenshot, create a file — no approval dialogs). Hard boundaries remain for
  credentials, account access, destructive irreversible operations, etc.

---

## 16. A.D.A.M. Additions (self-monitoring / self-repair / upgrades)

The core architecture above is complemented by continuous self-management
systems that start with the backend and stop cleanly on close:

| System | File | Responsibility |
|---|---|---|
| **Identity** | `contracts/identity.ts` | Canonical runtime identity (A.D.A.M. / ADAM / Charon / Sir); every prompt & personality string derives from it. |
| **State Machine** | `lifecycle/StateMachine.ts` | Backend states (IDLE→…→READY/OFFLINE/SHUTTING_DOWN) surfaced to the existing frontend; no redesign. |
| **Personality / Output** | `reasoning/PersonalityEngine.ts`, `reasoning/OutputEngine.ts` | Calm, formal A.D.A.M. presentation and coherent final-response composition (never alters facts). |
| **Health** | `maintenance/HealthEngine.ts` | Per-subsystem health (healthy/degraded/warning/critical/offline): python, providers, tools, memory. |
| **Error Observability** | `maintenance/ErrorObservabilityEngine.ts` | Every significant failure → structured ErrorRecord fed to maintenance/recovery/memory/telemetry. |
| **Maintenance** | `maintenance/MaintenanceEngine.ts` | Silent interval scan → MaintenanceFinding[]; observes only, never uncontrolled changes. |
| **Self-Repair** | `maintenance/SelfRepairEngine.ts` | Staged repair of failing tools: detect→classify→patch via coding agent→validate→sandbox→stage; never overwrites production unvalidated. |
| **Upgrade** | `upgrades/UpgradeEngine.ts` | Propose→build isolated candidate in `staging/upgrades/<id>`→validate→UPGRADE READY→user trial→automatic rollback on failure. |
| **Learning** | `maintenance/LearningEngine.ts` | Records successful/failed strategies and recalls relevant lessons on future requests. |
| **Subagents** | `orchestration/AgentOrchestrator.ts` | Scoped, bounded, disposable specialist subagents (architecture/python/security/provider/qa) with aggregated conclusions. |
| **Model matrix** | `providers/ProviderRegistry.ts` | Dynamic model capability matrix (reasoning/coding/speed/reliability/context), refreshed periodically; strongest-for-role selection. |

**Safety invariants (Systems 36):** Maintenance and Upgrade engines never
overwrite production, never install dependencies without validation, never
touch the frontend, never bypass sandbox/permissions, never replace working
tools with untested ones, and never delete user files or expose secrets. All
changes are staged and tested first; failed trials roll back automatically.

---

## 17. Testing

See `docs/NEW_BACKEND_VERIFICATION.md` for what is actually verified. The suite:

- **Unit tests** (`src/tests/unit/`): intent, naming, recovery, ledger
  (duplicate prevention + persistence), memory, capability discovery, path
  guard, validation (real Python AST checks).
- **Integration tests** (`src/tests/integration/`):
  - `forge.e2e` — full Forge lifecycle: missing capability → real Python source
    → validation → isolated sandbox test → registration → persistence →
    production execution → independent verification → reuse after restart
    (no duplicate). Includes the AI-generated path with a fake coding provider
    exercising the repair loop.
  - `backend.e2e` — the full `NovaBackend` master loop on a real directory:
    REAL REQUEST → INTENT → ENVIRONMENT → DISCOVERY → PLANNING → FORGE →
    SANDBOX → REGISTRATION → EXECUTION → VERIFICATION → MEMORY → RESULT.

Run with `npm test` inside `New Backend/` (requires Python 3). A CLI demo is at
`npm run demo` (and `scripts/demo.mjs`).
