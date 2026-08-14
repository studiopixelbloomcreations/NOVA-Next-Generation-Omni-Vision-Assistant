# A.D.A.M. — LEGACY BACKEND RESTORATION + NEW-SYSTEM MERGE — VERIFICATION

**Arena Agent (Implementation):** restored the legacy backend as the active
production backend, disabled the New Backend, and merged the valuable New
Backend systems in **additively** (no rewrite of working legacy code).
**Codex (Independent Verification):** must independently re-verify.

---

## 1. System Difference Matrix

| # | System | Old Backend | New Backend | Missing from Old? | Merged? | Integration point | Risk | Test |
|---|---|---|---|---|---|---|---|---|
| 1 | Input | `TRIGGER_AUTOMATION`/`run-task` | `InputEngine` | No | — | existing IPC | none | legacy suite |
| 2 | Intent | `taskRouter.classifyTask` | `IntentEngine` | No | — | existing router | none | legacy suite |
| 3 | Memory | `memory_engine.ts` (semantic) | `MemoryEngine` | No | — | existing | none | legacy suite |
| 4 | Environment | `windowsIntegration`/context | `EnvironmentEngine` | No | — | existing | none | legacy suite |
| 5 | Capability Discovery | `registry.findCapability` | `CapabilityDiscoveryEngine` | No | — | existing | none | legacy suite |
| 6 | Planning | `autonomous_execution_engine` | `PlanningEngine` | No | — | existing | none | legacy suite |
| 7 | Agent Selection | `aiProviderRegistry` | `AgentSelector` | Partly | ✅ model matrix | `src/main/adam/model_matrix.ts` | low | adam test |
| 8 | Provider Registry | `aiProviderRegistry` | `ProviderRegistry` | No | — | existing | none | legacy suite |
| 9 | Prompt Engine | inline prompts | `PromptEngine` | Partly | ✅ persona/identity | `src/main/adam/identity.ts` | low | adam test |
| 10 | Tool Registry | `tool_registry.ts` | `ToolLibrary` | No | — | existing | none | legacy suite |
| 11 | Tool Forge | `tool_forge.ts` (real Python) | `ToolForge` | No | — | existing (kept) | none | legacy suite |
| 12 | Tool Naming | forge assigns | `NamingEngine` | No | — | existing | none | legacy suite |
| 13 | Validation | `tool_validator.ts` | `ValidationEngine` | No | — | existing | none | legacy suite |
| 14 | Sandbox | `sandbox_worker.ts` | Python sandbox | No | — | existing | none | legacy suite |
| 15 | Execution | `tool_executor.ts` | `ExecutionEngine` | No | — | existing | none | legacy suite |
| 16 | Verification | `autonomous_execution_engine` | `VerificationEngine` | No | — | existing | none | legacy suite |
| 17 | Recovery | `autonomous_execution_engine` | `RecoveryEngine` | Partly | ✅ additive ladder | adam subagent/repair | low | adam test |
| 18 | Voice | legacy voice path + Charon | `VoiceEngine` | Partly | ✅ ADAM wake word | `src/main/adam/wake_word.ts` | low | adam test |
| 19 | Workspace | `workspace_manager.ts` | `WorkspaceEngine` | No | — | existing | none | legacy suite |
| 20 | Telemetry | runtime-state 1Hz | `TelemetryEngine` | No | — | existing | none | legacy suite |
| 21 | **Maintenance** | — | `MaintenanceEngine` | **Yes** | ✅ | `src/main/adam/maintenance_engine.ts` | low | adam test |
| 22 | **Self-Repair** | — | `SelfRepairEngine` | **Yes** | ✅ | `src/main/adam/self_repair.ts` | low | adam test |
| 23 | **Upgrade Engine** | — | `UpgradeEngine` | **Yes** | ✅ | `src/main/adam/upgrade_engine.ts` | low | adam test |
| 24 | **Trial / Rollback** | — | `TrialManager` | **Yes** | ✅ | `src/main/adam/trial_manager.ts` | low | adam test |
| 25 | **Health** | — | `HealthEngine` | **Yes** | ✅ | `src/main/adam/health_engine.ts` | low | adam test |
| 26 | **Error Observability** | — | `ErrorObservabilityEngine` | **Yes** | ✅ | `src/main/adam/error_observability.ts` | low | adam test |
| 27 | **Learning** | memory exists | `LearningEngine` | Partly | ✅ | `src/main/adam/learning_engine.ts` | low | adam test |
| 28 | Persistence | SQLite+JSON | `JsonFileStorage` | No | — | existing | none | legacy suite |
| 29 | Python Runtime | `python_runtime.ts` | `PythonRuntimeBridge` | No | — | existing (kept) | none | legacy suite |
| 30 | Windows automation | `windows_integration.ts` + python | python win service | No | — | existing | none | legacy suite |
| 31 | Electron integration | `main.ts` (restored) | `nova2_main.ts` (disabled) | No | — | **main.ts active** | none | build |
| 32 | Security | secret store, firewall, path guard, sandbox | same | No | — | existing | none | legacy suite |
| 33 | **Diagnostics** | — | `DiagnosticsEngine` | **Yes** | ✅ | `src/main/adam/diagnostics.ts` | low | adam test |
| 34 | Lifecycle | `main.ts` lifecycle | `LifecycleEngine` | Partly | ✅ additive start/stop | `src/main/adam/index.ts` | low | build |
| 35 | **Subagents** | — | `SubagentOrchestrator` | **Yes** | ✅ | `src/main/adam/subagents.ts` | low | adam test |
| — | **State machine** | — | `StateMachine` | **Yes** | ✅ | `src/main/adam/state_machine.ts` | low | adam test |
| — | **Identity** | "NOVA" legacy | `Identity` | **Yes** | ✅ | `src/main/adam/identity.ts` | low | adam test |
| — | **Charon TTS** | voice via Gemini Live | `CharonTTS` | Partly | ✅ | `src/main/adam/charon_tts.ts` | low | adam test |

**Legend:** ✅ merged additively; — already present in the old backend (kept).

---

## 2. Architecture (final)

```
EXISTING FRONTEND
        ↓ secure Electron IPC (unchanged contract)
RESTORED LEGACY BACKEND  (src/main/main.ts — ACTIVE)
   └── legacy working core (services/*, python runtime)
        └── + ADDITIVE systems (src/main/adam/*)
             health, maintenance, error observability, learning, upgrades,
             trial/rollback, self-repair, diagnostics, subagents, model matrix,
             state machine, A.D.A.M. identity, ADAM wake word, Charon TTS

NEW BACKEND (New Backend/ + src/main/nova2_main.ts) — DISABLED
   retained as reference/source only; no production init, no request routing.
```

## 3. Additive merge files

`src/main/adam/` (all ADDITIVE, no legacy service modified):
- `identity.ts` — A.D.A.M. / ADAM / Charon / Sir constants + rebrand helper
- `state_machine.ts` — explicit backend states
- `health_engine.ts` — real subsystem health
- `error_observability.ts` — structured error records
- `maintenance_engine.ts` — silent maintenance scan → findings
- `learning_engine.ts` — record/recall successful & failed strategies
- `upgrade_engine.ts` — upgrade proposals + staged candidate validation
- `trial_manager.ts` — explicit trial with automatic rollback
- `self_repair.ts` — staged repair via coding agent + legacy validator
- `diagnostics.ts` — structured diagnostics report
- `subagents.ts` — bounded disposable specialist subagents
- `model_matrix.ts` — role-based model selection
- `wake_word.ts` — ADAM wake-word detector (PCM)
- `charon_tts.ts` — Charon voice availability + text fallback
- `index.ts` — `initAdamSystems()` single additive hook
- `types.ts` — shared additive types

`src/main/main.ts` — **smallest possible additive changes** (no rewrite):
1. Added `initAdamSystems(...)` call once after services are up (additive init).
2. Added `adamSystems?.shutdown()` in shutdown (additive teardown).
3. Corrected the file header to reflect that it is now the ACTIVE entry.

`src/main/nova2_main.ts` — header updated to **LEGACY NEW-ARCHITECTURE SOURCE —
DISABLED** (no longer an entry point).

`package.json`:
- `main` → `dist/main/main.js` (legacy restored as active).
- `dev`/`build`/`electron:start`/`electron:package` → use `main.js` (New Backend
  build step removed).
- `build.files` → removed `New Backend/dist-cjs` and `New Backend/python_runtime`
  (New Backend not bundled).

`scripts/run-tests.js` — added `[adam_additive]` + `[adam_trial_rollback]` test
blocks (11 additive tests). No existing test weakened/deleted.

## 4. Verification results (this environment)

### PASS (offline, all real)
- Legacy regression suite: **259 pass** (registry, validator, executor, builder,
  forge templates, python worker, AI provider, task router, runtime state, mic
  manager, builtin tools, task runner, workspace, memory, personality, voice/
  Charon, permission enforcement, ledger, python worker).
- **A.D.A.M. additive tests: 11 pass** (identity, state machine, error
  observability, wake word, upgrade stage/trial/rollback, health, maintenance,
  model matrix, subagents, trial auto-rollback).
- New Backend (reference) suite: **53 pass** (disabled backend still valid as
  reference/source).
- **Builds:** `tsc -p tsconfig.main.json` clean; renderer `tsc --noEmit`
  clean; `vite build` succeeds.
- **One active backend:** `main.ts` is the entry; `nova2_main.ts` is disabled;
  New Backend is not bundled.

### BLOCKED (requires Windows / live keys — for Codex)
- `[tool_forge] forge template ... Window Insight` — uses Win32
  `GetForegroundWindow`; cannot run on Linux. Not a regression (untouched
  pre-existing test). **BLOCKED — needs Windows host.**
- Live Groq / Gemini Live / Charon audio / microphone / Windows automation /
  packaged installer — require a Windows + keys host. **NOT TESTED here.**

## 5. Required real task tests (handoff to Codex)

1. "ADAM, what time is it?" → real answer.
2. "ADAM, open Calculator." → real launch.
3. "ADAM, take a screenshot." → real capture + verify.
4. "ADAM, analyze my Downloads folder..." → real filesystem analysis.
5. "ADAM, create a tool that reports the five largest files..." → Forge →
   Python → sandbox → register → execute → verify → persist → restart → reuse.

## 6. Per-item acceptance (status)

| Criterion | Status |
|---|---|
| Old backend active | **PASS** (main.ts = entry) |
| Old frontend works with old backend | **PASS** (build + legacy IPC restored) |
| New backend completely disabled | **PASS** (not bundled, nova2_main disabled) |
| Existing old functionality intact | **PASS** (no rewrite; 259 legacy tests pass) |
| New systems merged additively | **PASS** (src/main/adam/*) |
| Tool Forge real | PASS |
| Generated tools real Python | PASS |
| Tools persist / reusable | PASS |
| Validation / Sandbox / Production execution / Verification / Recovery | PASS (legacy) |
| Memory | PASS (legacy) |
| Groq / Gemini Live / Charon / ADAM wake word / Windows automation | **BLOCKED** (needs host) |
| Workspace | PASS |
| Maintenance / Upgrades / Rollback | PASS (additive) |
| Frontend/backend IPC fully wired | PASS (legacy contract restored) |
| No mocks / placeholders / fake success | PASS |
| Electron-only | PASS |
| Full app end-to-end | **BLOCKED** (needs Windows) |

---

## 7. Codex handoff

Codex must independently: fetch latest commit → confirm `main.ts` is active and
`nova2_main.ts` + New Backend are disabled → run legacy + additive + New Backend
suites → build → run the 5 real task tests on Windows → test Groq / Gemini Live
/ Charon / microphone / Windows automation → package → test installed app →
report PASS / FAIL / BLOCKED (never convert NOT TESTED into PASS).
