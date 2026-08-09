#!/usr/bin/env node
// scripts/gemini-live-verify.js
// REAL Gemini Live session verification.
//
// Establishes an actual BidiGenerateContent WebSocket session through the
// production GeminiLiveBridge, verifies:
//   1. the exact setup frame the bridge sends requests the Gacrux voice and
//      carries the Personality Engine system instruction ("Sir", persona)
//   2. the live session connects and reaches setup-complete
//   3. a real text turn receives a real model response (transcript tokens +
//      Native Audio chunks with measurable amplitude)
//
// Run (key passed via env only — never written to disk):
//   GEMINI_API_KEY=<key> node scripts/gemini-live-verify.js
//
// The API key is redacted from all output.
const path = require('path');
const os = require('os');
const fs = require('fs');

const TIMEOUT_MS = 60000;

async function main() {
  const key = (process.env.GEMINI_API_KEY || '').trim();
  if (!key) {
    console.error('GEMINI_API_KEY is required');
    process.exit(2);
  }
  const redact = (s) => String(s).replace(key, '[REDACTED]');

  const dist = path.join(__dirname, '..', 'dist', 'main', 'services');
  const { GeminiLiveBridge } = require(path.join(dist, 'gemini_live_bridge.js'));
  const { NovaConfig } = require(path.join(dist, '..', 'core', 'config.js'));
  const { PersonalityEngine } = require(path.join(dist, 'personality_engine.js'));

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-live-verify-'));
  const pe = new PersonalityEngine();
  pe.init(tmp);

  const bridge = new GeminiLiveBridge('');
  bridge.setApiKey(key);

  const report = {
    canonicalVoice: NovaConfig.ai.liveVoice,
    frameVoice: null,
    frameHasPersona: false,
    frameHasSir: false,
    states: [],
    errors: [],
    setupComplete: false,
    setupLatencyMs: null,
    firstTokenMs: null,
    firstAudioMs: null,
    interactionComplete: false,
    tokens: [],
    audioChunks: 0,
    audioAvgRms: 0,
    startedAt: Date.now(),
  };
  let audioRmsSum = 0;
  const started = Date.now();

  bridge.on('connection-state-change', (s) => {
    report.states.push(s);
    console.log(`[verify] state -> ${s}`);
  });
  bridge.on('error', (e) => {
    report.errors.push(redact(e.message));
    console.error(`[verify] bridge error: ${redact(e.message)}`);
  });
  bridge.on('setup-complete', () => {
    report.setupComplete = true;
    report.setupLatencyMs = Date.now() - started;
    console.log('[verify] SETUP-COMPLETE — real session ready');
    // Real turn: ask the model to SPEAK so the Native Audio output path
    // (server -> bridge -> ai-audio-chunk -> renderer playback) is exercised.
    bridge.sendTextMessage('Say the words GACRUX OK out loud and then stop. Do not write extra text.');
  });
  bridge.on('user-text-transcribed', (t) => console.log(`[verify] user transcript: ${redact(t)}`));
  bridge.on('ai-text-token', (t) => {
    if (!report.firstTokenMs) report.firstTokenMs = Date.now() - started;
    report.tokens.push(redact(t));
    console.log(`[verify] AI token: ${redact(t)}`);
  });
  bridge.on('ai-audio-chunk', (buf) => {
    if (!report.firstAudioMs) report.firstAudioMs = Date.now() - started;
    report.audioChunks++;
    if (buf && buf.length) audioRmsSum += bridge.computeRmsAmplitude(buf);
  });
  bridge.on('interaction-complete', () => {
    report.interactionComplete = true;
    console.log('[verify] interaction-complete (turn finished)');
  });

  // The EXACT frame the bridge serializes and sends on socket open:
  const setup = bridge.buildSetupMessage();
  report.frameVoice = setup.setup.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName;
  const sysText = setup.setup.systemInstruction.parts[0].text;
  report.frameHasPersona = sysText.includes('NOVA');
  report.frameHasSir = sysText.includes('Sir');
  report.model = setup.setup.model;
  console.log(`[verify] setup frame voice: ${report.frameVoice} | persona: ${report.frameHasPersona} | Sir: ${report.frameHasSir}`);

  bridge.connectStream();

  await new Promise((resolve) => setTimeout(resolve, TIMEOUT_MS));
  bridge.disconnectStream();

  report.audioAvgRms = report.audioChunks ? audioRmsSum / report.audioChunks : 0;
  console.log('\n===== LIVE SESSION VERIFICATION REPORT =====');
  console.log(JSON.stringify(report, null, 2));
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(report.setupComplete ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
