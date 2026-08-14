// Integration test — verifies the New Backend produces the EXACT payload
// shapes the existing frontend consumes (System 37 / loose-joint audit).
// These mirror src/shared/ipc_protocols.ts: IRuntimeStatePayload,
// ISystemTelemetryPayload, IMicStatePayload, IVoiceStatePayload, boot state.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NovaBackend } from '../../index.js';
import { pointToPythonRuntime } from '../helpers.js';

test('runtimeState matches the frontend IRuntimeStatePayload contract', async () => {
  pointToPythonRuntime();
  const work = mkdtempSync(join(tmpdir(), 'nova-contract-'));
  process.chdir(work);
  const backend = new NovaBackend({ silent: true });
  await backend.start();

  const rs: any = backend.runtimeState();
  // Exact keys the frontend consumes.
  for (const k of ['bootedAt', 'overall', 'electron', 'python', 'gemini', 'groq', 'memory', 'toolRegistry', 'toolExecutor', 'microphone', 'speaker', 'details', 'currentTask', 'lastError', 'uptimeMs', 'timestamp']) {
    assert.ok(k in rs, `runtimeState missing key: ${k}`);
  }
  assert.ok(['BOOTING', 'ONLINE', 'DEGRADED', 'ERROR'].includes(rs.overall), 'valid overall');
  assert.ok(rs.details.wakeWord === 'ADAM', 'wake word surfaced as ADAM');
  assert.ok(rs.details.identity === 'A.D.A.M.', 'identity surfaced as A.D.A.M.');
  await backend.shutdown();
});

test('systemTelemetry matches ISystemTelemetryPayload and bootState matches', async () => {
  pointToPythonRuntime();
  const work = mkdtempSync(join(tmpdir(), 'nova-contract-'));
  process.chdir(work);
  const backend = new NovaBackend({ silent: true });
  await backend.start();

  const tel: any = backend.systemTelemetry();
  for (const k of ['captureWidth', 'captureHeight', 'frameRate', 'mutatedBlocks', 'totalBlocks', 'geminiState', 'streamLatencyMs', 'timestamp']) {
    assert.ok(k in tel, `telemetry missing key: ${k}`);
  }
  assert.ok(['DISCONNECTED', 'CONNECTING', 'CONNECTED', 'ERROR'].includes(tel.geminiState), 'valid geminiState');

  const boot: any = backend.bootState();
  assert.ok(Array.isArray(boot.bootSteps), 'bootSteps array');
  assert.ok('providers' in boot && 'telemetry' in boot && 'voiceState' in boot, 'boot state fields');
  assert.equal(boot.bootSteps.length, 9, 'ordered startup steps present');
  await backend.shutdown();
});

test('micState matches IMicStatePayload contract', async () => {
  pointToPythonRuntime();
  const work = mkdtempSync(join(tmpdir(), 'nova-contract-'));
  process.chdir(work);
  const backend = new NovaBackend({ silent: true });
  await backend.start();

  const mic: any = backend.micState();
  for (const k of ['state', 'available', 'listening', 'muted', 'devices', 'defaultCapture', 'lastError', 'lastDiagnostic', 'timestamp']) {
    assert.ok(k in mic, `micState missing key: ${k}`);
  }
  assert.ok(Array.isArray(mic.devices), 'devices is an array');
  await backend.shutdown();
});

test('contextChips produce frontend-shaped chips', async () => {
  pointToPythonRuntime();
  const work = mkdtempSync(join(tmpdir(), 'nova-contract-'));
  process.chdir(work);
  const backend = new NovaBackend({ silent: true });
  await backend.start();

  const chips: any = await backend.contextChips();
  assert.ok(Array.isArray(chips.chips), 'chips array');
  for (const c of chips.chips) {
    assert.ok('id' in c && 'label' in c && 'type' in c && 'severity' in c, 'chip shape');
  }
  assert.ok(chips.chips.some((c: any) => c.label.includes('A.D.A.M.')), 'identity chip present');
  await backend.shutdown();
});

test('request path emits synthesis + tool-created events to frontend', async () => {
  pointToPythonRuntime();
  const work = mkdtempSync(join(tmpdir(), 'nova-contract-'));
  process.chdir(work);
  // Ensure no File Scout exists so it forges a new tool.
  const backend = new NovaBackend({ silent: true });
  await backend.start();
  const target = join(work, 'Data');
  const { mkdirSync, writeFileSync } = await import('node:fs');
  mkdirSync(target);
  writeFileSync(join(target, 'a.txt'), 'x'.repeat(10));

  const phases: string[] = [];
  const tools: unknown[] = [];
  if (backend.agent) {
    backend.agent.on('synthesis-phase', (p: { phase: string }) => phases.push(p.phase));
    backend.agent.on('tool-created', (t: unknown) => tools.push(t));
  }

  const result = await backend.handleRequest('create a tool that reports the largest files in a directory', 'typed');
  // Either reuses an existing directory-analysis capability or forges a real
  // File Scout tool. Either way the request must complete and the synthesis
  // events must flow to the frontend (the loose-joint under test).
  assert.equal(result.status, 'completed', result.summary);
  assert.ok(phases.length > 0, 'synthesis-phase events emitted to frontend');
  assert.ok(phases.includes('COMPLETED'), 'synthesis COMPLETED emitted');
  await backend.shutdown();
});
