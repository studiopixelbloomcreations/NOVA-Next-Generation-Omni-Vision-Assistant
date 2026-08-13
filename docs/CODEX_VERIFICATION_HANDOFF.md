# CODEX — INDEPENDENT VERIFICATION HANDOFF PROMPT

You are **Codex — the independent Test / Verification Authority** for the
**A.D.A.M.** project (Arena Agent = Implementation Authority; you = Codex =
Independent Verification Authority).

Do **not** trust prior reports. Fetch the latest repository and verify directly.

---

## Your mission

```
1. Fetch the latest repository.
2. Checkout the latest main branch.
3. Inspect git history.
4. Audit the New Backend (New Backend/) — engines, orchestration, forge,
   validation, sandbox, execution, verification, recovery, memory, maintenance,
   upgrades, self-repair, voice, diagnostics, lifecycle.
5. Confirm the legacy backend (src/main/main.ts + src/main/services/*) is
   LEGACY — DISABLED and NOT the entry point; the active entry is
   src/main/nova2_main.ts booting only New Backend/dist-cjs.
6. Confirm the frontend is visually UNCHANGED (no renderer redesign).
7. Confirm identity: runtime AI is A.D.A.M., wake word ADAM, voice Charon,
   prompts/persona use A.D.A.M. (repo name + file paths may keep NOVA).
8. Run the backend test suite. Build both ESM and CJS.
9. Run the real end-to-end and live-host tests listed below.
10. Package the Electron app and test the installed application.
11. Fix only verified defects; rerun full regression.
12. Report exact evidence (what passed, what failed, with logs).
```

---

## Environment requirements (set up on the real Windows host)

- Windows 10/11
- Python 3.10+ with optional deps for live features:
  `pip install faster-whisper sounddevice Pillow mss pyautogui pywin32 pyttsx3`
- Node 18.17+ (Electron 32)
- API keys in the NOVA Secrets vault or env:
  `GEMINI_API_KEY`, `GROQ_API_KEY`
- A working microphone + speaker

---

## Test matrix (System 42) — run and record evidence

### A. Offline (no keys needed) — must pass in any environment
- [ ] `cd "New Backend" && npm install && npm test` → all tests pass.
- [ ] `npm run build` (ESM) and `npm run build:cjs` (CJS) compile clean.
- [ ] Confirm `dist-cjs` is `require()`-able.
- [ ] `npm run demo` — real "analyze a directory" autonomous run completes and
      reports the largest file; tool is persisted and reused (no duplicate).
- [ ] Confirm the suite is stable: run it 3+ times; investigate any flaky test.
- [ ] Forge lifecycle offline: create → validate → sandbox → register → execute
      → verify → persist → restart → reuse (no duplicate tool).

### B. Live — requires keys + Windows + audio
- [ ] **Groq:** real reasoning/planning/forge/repair calls succeed; a forged
      Python tool is generated from a real Groq completion, sandbox-tested, and
      executed.
- [ ] **Gemini REST + Gemini Live:** connect; text round-trip; audio round-trip;
      tool-call from Gemini Live executes an A.D.A.M. capability and returns the
      result; barge-in/interruption works.
- [ ] **Charon TTS:** `tts.speak` produces audible voice output.
- [ ] **Whisper + microphone:** capture + transcribe; the wake word **ADAM**
      wakes the always-on voice loop.
- [ ] **Always-on voice:** "ADAM" → listen → transcribe → execute → Charon
      responds; user interrupting mid-speech is handled (barge-in).
- [ ] **Windows automation:** "Open Calculator" launches it; active window,
      screenshot (→ workspace), clipboard, keyboard/mouse work; verification
      confirms the action.
- [ ] **Self-repair with real Groq:** a broken staged tool is auto-repaired,
      sandbox-tested, and staged (production untouched).
- [ ] **Upgrade trial + auto-rollback:** a validated upgrade is trialed; a
      simulated degradation triggers AUTOMATIC rollback.
- [ ] **Self-close:** "ADAM, close yourself" → clean shutdown; no zombie Python
      workers / orphaned subprocesses.

### C. Packaging / installed app (Windows + electron-builder)
- [ ] `npm run electron:package` produces an installer (NSIS/portable).
- [ ] Installed app boots, reaches READY, tool library rehydrates from disk,
      maintenance/upgrade engines start, voice loop is active.
- [ ] No localhost server, no browser backend, no port-based service.
- [ ] Frontend visual design is unchanged from the original NOVA UI.

---

## Verification protocol (System 51)

1. Run internal tests → 2. build → 3. integration → 4. real task tests →
5. (implementation already committed) → 6. you fetch latest commit →
7. you audit → 8. you run complete verification → 9. you fix only verified
   defects → 10. rerun complete regression → 11. package → 12. test installed
   app → 13. report exact evidence.

---

## Release criterion

A.D.A.M. is **complete** only when BOTH columns of the System-50 checklist pass
in your environment:

✓ voice-first   ✓ wake word ADAM   ✓ low-latency input   ✓ Gemini Live
✓ Charon   ✓ Groq   ✓ dynamic model selection   ✓ subagent creation
✓ autonomous planning   ✓ capability discovery   ✓ Tool Forge   ✓ real Python tools
✓ persistent local tool library   ✓ tool naming   ✓ tool reuse   ✓ validation
✓ sandbox   ✓ real execution   ✓ independent verification   ✓ recovery   ✓ memory
✓ workspace   ✓ Windows control   ✓ maintenance   ✓ self-repair   ✓ upgrade staging
✓ upgrade rollback   ✓ health monitoring   ✓ telemetry   ✓ lifecycle
✓ clean shutdown   ✓ Electron-only   ✓ no localhost backend   ✓ frontend unchanged
✓ no mocks   ✓ no placeholders   ✓ no fake success

If the **offline (A)** column does not pass, that is a defect you must fix and
re-run. If only the **live (B)/packaging (C)** column fails because of a missing
host/key, record exact evidence and state precisely what remains blocked.

Report back: **what passed (with evidence/logs), what failed, and what is
explicitly still blocked.**
