# NOVA Genesis — Repository Repair Report

## Scope

This repair pass was performed directly against the current `main` branch. The requested provider architecture is:

- **Gemini Live Native Audio** — conversational/voice head
- **Charon** — canonical Gemini Live voice
- **Groq** — reasoning, planning, engineering and tool-synthesis head
- **NOVA Core** — execution authority

No Grok/xAI provider is intended by this architecture.

## Changes committed

### 1. Groq provider correction

Replaced the previous xAI/Grok provider implementation with a real Groq OpenAI-compatible API adapter:

- endpoint: `https://api.groq.com/openai/v1/chat/completions`
- secret: `GROQ_API_KEY`
- model: configurable through `NOVA_GROQ_MODEL`
- default: `llama-3.3-70b-versatile`
- provider ID: `groq`

Reasoning, engineering, planning and tool-synthesis routes now target `groq`.

### 2. Strict reasoning-provider routing

Reasoning/engineering/tool-synthesis tasks no longer silently fall back to Gemini when Groq is unavailable. NOVA Core receives an explicit unavailable-provider state so it can recover instead of using the wrong model.

### 3. Charon canonical voice

`NovaConfig.ai.liveVoice` is now explicitly canonicalized to `Charon` unless overridden intentionally by `NOVA_LIVE_VOICE`.

The Gemini Live bridge already consumes this centralized value for its speech configuration, so the runtime voice path has a single configuration source.

### 4. Picovoice secret handling

Wake-word initialization no longer needs to read `PICOVOICE_ACCESS_KEY` from `process.env`. The detector now accepts the secret through an in-memory setter and accurately reports its readiness state.

Wake-word states are now:

- `real-porcupine`
- `fallback-rms`
- `unavailable`

`isReady()` no longer returns `true` when no usable wake-word capability exists.

### 5. Build/release failure masking

Removed the `|| true` from the native rebuild `postinstall` script. Native rebuild failures must now fail installation instead of being silently reported as success.

The obsolete `dev:dual` server-oriented script was also removed from the package scripts. The supported development path remains Electron-based.

## Important verification boundary

This repository repair was performed through the GitHub source-control integration. The following require a real Windows runtime and must therefore be independently executed by Codex on the target PC:

- microphone hardware capture
- Whisper model/runtime availability
- native Electron ABI rebuild
- Windows Python runtime behavior
- real Windows automation
- Gemini Live network session
- Groq network session
- Electron packaging
- NSIS installer execution
- portable executable execution

These are intentionally **not** marked as passed by this report.

## Required post-repair verification

Run the full Codex verification prompt supplied with this repair, including:

```text
npm install
npm run typecheck
npm run lint
npm test
npm run e2e:smoke
npm run build
npm run electron:package
```

Then test the generated Windows installer and portable executable on the target machine.

## Provider contract

The intended architecture is now unambiguous:

```text
USER
  |
  v
Whisper / Gemini Live Audio
  |
  v
NOVA Core Turn Manager
  |
  +---- conversation/media ----> Gemini Live
  |
  +---- reasoning/planning ----> Groq
  |
  +---- engineering/tool forge -> Groq
  |
  v
NOVA Core execution authority
  |
  +---- Python / Windows tools
  +---- workspace tools
  +---- registered tools
```

Gemini and Groq do not independently own physical computer execution.
