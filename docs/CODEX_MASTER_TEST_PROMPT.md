# CODEX — MASTER INDEPENDENT VERIFICATION PROMPT

You are **Codex — Independent Test / Verification Authority** for the
**A.D.A.M.** project. The Arena Agent implemented; you verify. Do NOT trust any
report — fetch the latest repository and test directly. You may fix only
**verified defects**; then rerun full regression and report exact PASS/FAIL/
BLOCKED evidence.

**Repository (source of truth):**
https://github.com/studiopixelbloomcreations/NOVA-Next-Generation-Omni-Vision-Assistant
Branch `main`. Commit range to verify starts after `ad85253` (the
frontend↔backend wiring repair).

**Target host:** Windows 10/11 + Python 3.10+ + Node 18.17+ (Electron 32) +
a working microphone + speaker.

**Live test credentials required:** `GEMINI_API_KEY`, `GROQ_API_KEY` (set in
the NOVA Secrets vault or env).

**Optional Python deps for live features:**
`pip install faster-whisper sounddevice Pillow mss pyautogui pywin32 pyttsx3`

---

## Step 0 — Build & typecheck (must be clean)

```bash
cd "New Backend" && npm install && npm test      # expect 53/53 pass
npm run build        # ESM clean
npm run build:cjs    # CJS clean, require()able
python3 -m compileall -q python_runtime

cd ..  # repo root
npm install --ignore-scripts
npx tsc -p tsconfig.main.json --noEmit   # Electron main clean
npx tsc --noEmit -p tsconfig.json        # renderer clean
npm run lint
npx vite build --config vite.config.mts   # renderer bundles
```

Confirm: NO production mocks/placeholders/TODOs (scan `New Backend/src` +
`src/renderer` + `src/main/nova2_main.ts`).

---

## Step 1 — Backend integration tests (no keys needed)

- [ ] Forge lifecycle end-to-end (create → validate → sandbox → register →
      execute → verify → persist → restart → reuse, no duplicate).
- [ ] NovaBackend master loop on a real directory.
- [ ] Frontend-contract shapes (runtimeState/telemetry/mic/boot/contextChips)
      match `src/shared/ipc_protocols.ts` exactly.
- [ ] Request path emits `synthesis-phase` + `tool-created` events.
- [ ] Suite is stable: run `npm test` 3+ times, no flaky failures.

---

## Step 2 — Live host tests (require keys + Windows + audio)

- [ ] **Groq:** real reasoning/planning/forge/repair calls succeed; a forged
      Python tool is generated from a real Groq completion, sandbox-tested,
      and executed on the real machine.
- [ ] **Gemini REST + Gemini Live:** connect; text + audio round-trip; a
      Gemini Live tool-call executes an A.D.A.M. capability and returns the
      result; barge-in/interruption works; reconnect on disconnect.
- [ ] **Charon TTS:** `tts.speak` produces audible voice.
- [ ] **Whisper + microphone:** capture + transcribe; wake word **ADAM**
      wakes the always-on voice loop.
- [ ] **Always-on voice:** "ADAM" → wake → listen → transcribe → execute →
      Charon responds; interrupting mid-speech (barge-in) works; finalize
      promptly on silence.
- [ ] **Windows automation:** "Open Calculator" launches it; active window,
      screenshot (→ workspace), clipboard, keyboard/mouse; independent
      verification confirms the action.
- [ ] **Self-repair with real Groq:** a broken staged tool is auto-repaired,
      sandbox-tested, staged (production untouched).
- [ ] **Upgrade trial + auto-rollback:** a validated upgrade is trialed; a
      simulated degradation triggers AUTOMATIC rollback.
- [ ] **Self-close:** "ADAM, close yourself" → clean shutdown; no zombie
      Python workers / orphaned subprocesses.

---

## Step 3 — Full Electron application (live)

1. Launch the app (`npm run dev` / `npm run electron:start`).
2. Click the orb → HUD appears and responds.
3. HUD shows real subsystem states (PYTHON/GEMINI/GROQ/MEMORY/TOOLS) — must
   reflect actual backend state, never fabricated ONLINE/LISTENING/EXECUTING.
4. Say "ADAM" → wake → listen.
5. Speak "Open Calculator" → it launches on the real PC.
6. Type/ask "give me system information" → real result in transcript.
7. "Take a screenshot" → real capture presented in the workspace.
8. Directory analysis → real result.
9. Forge a missing capability → synthesis panel shows real progress →
   tool-created → persists.
10. Restart the app → forged tool reused (no duplicate).
11. Workspace research → content appears inside the workspace surface.
12. Window controls (minimize/maximize/close) work.
13. "ADAM, close yourself" → clean exit.

---

## Step 4 — Packaging (Windows + electron-builder)

- [ ] `npm run electron:package` produces an installer (NSIS/portable).
- [ ] Installed app boots → READY → backend initializes → tools rehydrate →
      maintenance/upgrade engines start → voice loop active.
- [ ] No localhost server / browser backend / port-based service.
- [ ] Frontend visual design unchanged (identity rebranded to A.D.A.M. text,
      same layout/colors/HUD/orb).

---

## Step 5 — Report

Return exact evidence:
- **PASS** — with command output / screenshots / logs.
- **FAIL** — with the reproduction and the fix you applied + re-run result.
- **BLOCKED** — with the specific missing host/key and the exact feature blocked.

Do NOT claim the release complete until both the offline suite (Step 1) AND the
live-host + packaging (Steps 2–4) columns pass.
