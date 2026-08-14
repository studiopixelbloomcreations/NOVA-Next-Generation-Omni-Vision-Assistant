# A.D.A.M. — Frontend ↔ Backend Wiring Repair Report

**Author:** Arena Agent (Implementation Authority)
**Repo:** https://github.com/studiopixelbloomcreations/NOVA-Next-Generation-Omni-Vision-Assistant
**Branch:** `main`

This report documents the complete **frontend ↔ backend loose-joint audit and
repair** (Systems 37 + frontend/backend audit) that makes the existing UI and
the New Backend operate as ONE system.

---

## 1. What was found (the loose joints)

The New Backend existed and was well-implemented, but its Electron adapter was
minimal. The existing frontend (`src/App.tsx` + `src/renderer/*`) subscribes to
a **rich IPC contract** from `src/shared/ipc_protocols.ts`. Most of those
channels were **not** wired to the backend, so the UI would render as a
**static shell** (no live state, no mic, no telemetry, no tool synthesis, no
voice). Concretely:

| Frontend needs | Backend provided before | Result |
|---|---|---|
| `IRuntimeStatePayload` shape | different shape (`backend`, `providers`, `capabilityIndex`) | HUD showed undefined subsystem states |
| `ISystemTelemetryPayload` | none emitted | no live metrics |
| `IMicStatePayload` | none | mic control inert |
| `MIC_TOGGLE` / `MIC_DIAGNOSTIC` / `GET_MIC_STATE` / `MIC_SET_MUTED` / `MIC_DISCOVER` | not handled | mic UI dead |
| `TOOL_APPROVE` / `TOOL_REJECT` | not handled | approval UI dead |
| `user-audio-chunk` / `user-speaking-active` | not received | no voice input path |
| `MIC_CAPTURE_ACTIVE` / `MIC_CAPTURE_ERROR` | not received | mic state machine never confirms |
| `camera-frame` | not received | no vision to Gemini Live |
| `ai-audio-chunk` / `ai-amplitude` / `ai-text-token` | not forwarded | no AI output shown/heard |
| `agent-tool-synthesis-*` / `agent-tool-created` | not emitted | tool forge UI dead |
| `CONTEXT_CHIP_UPDATE` | not emitted | chips dead |
| `SYSTEM_TELEMETRY` (~1Hz) | not emitted | metrics dead |
| `nova-ipc:boot-lifecycle` | not pushed | boot tracker stuck |
| `window-minimize/maximize/close`, `HUD_VISIBILITY_REQ` | not handled | window controls dead |
| runtime identity "NOVA AI" / "NOVA" | remained | identity inconsistency |

---

## 2. What was fixed

### Backend IPC contract (`New Backend/src/contracts/ipc.ts`)
Rewrote to **exactly mirror** `src/shared/ipc_protocols.ts`: `RuntimeStatePayload`
(IRuntimeStatePayload), `SystemTelemetryPayload` (ISystemTelemetryPayload),
`MicStatePayload` (IMicStatePayload), `VoiceStatePayload`, `ContextChipPayload`,
`BootStatePayload`, plus the full `NovaIpcChannel` set and the A.D.A.M.
`nova2:*` additions.

### Backend facade (`New Backend/src/index.ts`)
- `runtimeState()` now returns the **exact IRuntimeStatePayload shape**
  (electron/python/gemini/groq/memory/toolRegistry/toolExecutor/microphone/
  speaker/details/currentTask/lastError/uptimeMs/timestamp).
- Added `systemTelemetry()`, `micState()`, `contextChips()`, `recentActivity()`
  producing the precise frontend shapes.
- `bootState()` now returns `{ bootSteps, telemetry, voiceState, providers,
  timestamp }` matching the frontend's `GET_BOOT_STATE` expectation.
- Wired all voice sub-components (wake detector, mic, Whisper, Gemini Live,
  Charon) into the facade.

### Electron adapter (`New Backend/src/electron_adapter.ts`) — comprehensive rewrite
Wires **BOTH directions** (System 37):

**Backend → Frontend (events):**
- `nova-ipc:boot-lifecycle` on every boot step
- `nova-sys:runtime-state-change` on state-machine transitions
- `nova-sys:runtime-activity` from the agent activity feed
- `nova-sys:voice-state-change` (mapped to NovaVoiceState) + transcription
- `nova-sys:mic-state-change` on mic changes
- `nova-sys:telemetry-update` (~1Hz) + `nova-ui:context-chip-update`
- `ai-text-token`, `ai-audio-chunk`, `nova-sys:audio-buffer-flush` from Gemini Live
- `agent-tool-synthesis-phase`, `agent-tool-synthesis-steps`,
  `agent-tool-created` from the agent's forge loop
- `nova-sys:workspace-update` from the workspace engine

**Frontend → Backend (invoke):** all core request paths + tool registry,
memory, system info, runtime/boot state, mic (toggle/diagnostic/discover/
muted/state), workspace (list/close/open-url), tool approve/reject, plus
`nova2:*` A.D.A.M. additions.

**Frontend → Backend (send):** `user-audio-chunk` → voice engine PCM,
`user-speaking-active` → voice utterance start/end, `MIC_CAPTURE_ACTIVE` /
`MIC_CAPTURE_ERROR` → mic manager, `camera-frame` → Gemini Live vision,
`HUD_VISIBILITY_REQ` (window).

### Orchestrator (`New Backend/src/orchestration/NovaAgent.ts`)
- Emits `synthesis-phase` (PLANNING/FORGING/EXECUTING/COMPLETED/FAILED) and
  `tool-created` events so the frontend's tool-forge UI shows real progress.
- Removed a duplicated step-execution loop (real bug found during audit).

### Electron main (`src/main/nova2_main.ts`)
- Added real `window-minimize/maximize/close` IPC handlers.
- Added real `HUD_VISIBILITY_REQ` handler (mouse event pass-through toggle).
- Fixed `will-attach-webview` typing.

### Identity migration (System 49) — frontend
- `src/App.tsx`: transcript sender `'NOVA AI'` → `'A.D.A.M.'`; error text.
- `src/renderer/components/RightPanel.tsx`: `ITranscriptEntry.sender` union.
- `src/renderer/components/Sidebar.tsx`: brand header/footer `NOVA AI` → `A.D.A.M.`.
- `src/renderer/index.html`: `<title>` → `A.D.A.M. — Autonomous Digital Analytical Mind`.

---

## 3. Verification performed (in this environment)

- **Backend suite: 53/53 tests pass** (was 48). Added `frontend_contract.test.ts`
  (5 tests) verifying the exact IRuntimeStatePayload / ISystemTelemetryPayload /
  IMicStatePayload / context-chip / boot-state shapes, and that the request path
  emits synthesis + tool-created events the frontend consumes.
- **Backend builds:** ESM + CJS compile clean.
- **Electron main typecheck** (`tsconfig.main.json`): clean.
- **Renderer typecheck** (`tsconfig.json`): clean.
- **Renderer production bundle** (`vite build`): succeeds.
- **Lint:** clean.
- **Python runtime:** `compileall` clean; all modules import.
- **Demo:** real autonomous "analyze a directory" run completes.

---

## 4. What still requires a live Windows host (Codex must verify)

- Actual Electron window launch + real window controls + HUD pass-through.
- Real microphone (getUserMedia) → PCM → wake word ADAM → Whisper → execute.
- Real Gemini Live WebSocket (audio/text/vision/tool-call/barge-in).
- Real Charon TTS (Windows SAPI/pyttsx3).
- Real Groq reasoning/coding/forge with a live key.
- Real Windows automation (launch Calculator, screenshot, active window).
- Packaged installer + installed-app run.
- Verified in a Linux sandbox; these require the Windows target.
