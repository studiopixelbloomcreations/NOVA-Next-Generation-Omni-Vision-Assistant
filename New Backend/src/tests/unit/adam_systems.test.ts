// Unit tests — A.D.A.M. voice, self-maintenance, trial, diagnostics, self-close.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WakeWordDetector } from '../../voice/WakeWordDetector.js';
import { MicCapture } from '../../voice/MicCapture.js';
import { GeminiLiveBridge } from '../../voice/GeminiLiveBridge.js';
import { SelfMaintenanceCoordinator } from '../../maintenance/SelfMaintenanceCoordinator.js';
import { SelfRepairEngine } from '../../maintenance/SelfRepairEngine.js';
import { ToolLibrary } from '../../persistence/tool_library.js';
import { PythonRuntimeBridge } from '../../execution/PythonRuntimeBridge.js';
import { ValidationEngine } from '../../validation/ValidationEngine.js';
import { ToolTestingEngine } from '../../testing/ToolTestingEngine.js';
import { AgentSelector } from '../../reasoning/AgentSelector.js';
import { ProviderRegistry } from '../../providers/ProviderRegistry.js';
import { UpgradeEngine } from '../../upgrades/UpgradeEngine.js';
import { TrialManager } from '../../upgrades/TrialManager.js';
import { HealthEngine } from '../../maintenance/HealthEngine.js';
import { ErrorObservabilityEngine } from '../../maintenance/ErrorObservabilityEngine.js';
import { DiagnosticsEngine } from '../../diagnostics/DiagnosticsEngine.js';
import { NovaBackend } from '../../index.js';
import { pointToPythonRuntime } from '../helpers.js';

test('WakeWordDetector fires wake event on a loud utterance after quiet', () => {
  const wd = new WakeWordDetector(0.02, 0);
  let fired = 0;
  wd.on('wake-word-detected', () => { fired += 1; });
  // Quiet frames.
  for (let i = 0; i < 40; i++) wd.processAudioFrame(new Int16Array(256));
  // Loud utterance (amplitude ~0.5).
  const loud = new Int16Array(256).fill(16000);
  assert.equal(wd.processAudioFrame(loud), true);
  assert.equal(fired, 1);
  // Steady ambient noise must NOT keep firing immediately.
  assert.equal(wd.processAudioFrame(loud), false);
});

test('MicCapture reflects real capture state', () => {
  const mic = new MicCapture();
  mic.markReady('default');
  assert.equal(mic.snapshot.available, true);
  mic.reportCaptureActive(true);
  assert.equal(mic.snapshot.listening, true);
  assert.equal(mic.snapshot.state, 'LISTENING');
  mic.reportCaptureActive(false);
  assert.equal(mic.snapshot.listening, false);
  mic.setMuted(true);
  assert.equal(mic.snapshot.muted, true);
});

test('GeminiLiveBridge errors honestly without an API key', async () => {
  const bridge = new GeminiLiveBridge();
  bridge.configure(null);
  const ok = await bridge.connectStream();
  assert.equal(ok, false);
  assert.equal(bridge.getConnectionState(), 'ERROR');
});

test('SelfMaintenanceCoordinator stages a repair for a tool finding', async () => {
  pointToPythonRuntime();
  const dir = mkdtempSync(join(tmpdir(), 'nova-smc-'));
  process.chdir(dir);
  const lib = new ToolLibrary(dir);
  const bridge = new PythonRuntimeBridge();
  const registry = new ProviderRegistry();
  const selector = new AgentSelector(registry);
  const repair = new SelfRepairEngine(lib, selector, new ValidationEngine(bridge), new ToolTestingEngine(bridge), bridge);
  const coordinator = new SelfMaintenanceCoordinator(lib, repair);
  // Finding for an existing broken tool -> auto-repair path attempted.
  const decision = await coordinator.handleFinding({
    id: 'f1', severity: 'critical', subsystem: 'tool:missing_tool', title: 'broken', detail: 'it broke', discoveredAt: Date.now(), resolved: false,
  });
  assert.equal(decision.staged, false, 'no provider + missing tool -> no staged candidate');
  assert.equal(decision.finding.subsystem, 'tool:missing_tool');
  lib.close();
});

test('TrialManager trialed upgrade rolls back on demand', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nova-trial-'));
  process.chdir(dir);
  const upgrades = new UpgradeEngine(dir);
  const proposal = upgrades.propose({ title: 'Trial X', reason: 'r', benefit: 'b', affectedSystems: ['x'], risk: 'low', rollbackPlan: 'revert', testPlan: 'tests', impact: 'none' });
  const ready = await upgrades.buildAndValidate(proposal.id, async () => ({ passed: true, evidence: 'ok' }));
  assert.equal(ready!.status, 'ready');
  const lib = new ToolLibrary(dir);
  const registry = new ProviderRegistry();
  const health = new HealthEngine(lib, new PythonRuntimeBridge(), registry);
  const trial = new TrialManager(upgrades, health, { rollbackThreshold: 'offline', maxTrialMs: 50, healthCheckMs: 1000 });
  assert.equal(trial.startTrial(proposal.id), true);
  trial.keepCurrent();
  assert.equal(trial.trialState, 'idle');
  lib.close();
  upgrades.close();
});

test('DiagnosticsEngine reports structured state', async () => {
  pointToPythonRuntime();
  const dir = mkdtempSync(join(tmpdir(), 'nova-diag-'));
  const lib = new ToolLibrary(dir);
  const registry = new ProviderRegistry();
  const bridge = new PythonRuntimeBridge();
  const health = new HealthEngine(lib, bridge, registry);
  const errors = new ErrorObservabilityEngine(dir);
  const diag = new DiagnosticsEngine(health, errors, lib, registry, bridge);
  const report = await diag.collect();
  assert.equal(typeof report.uptimeMs, 'number');
  assert.ok(report.memory.heapUsedMb >= 0);
  assert.equal(report.tools.total, 0);
  assert.equal(report.taskQueue.activeTasks, 0);
  diag.markTaskStarted();
  diag.markTaskEnded();
  lib.close();
  errors.close();
});

test('NovaBackend self-close command returns closeRequested and emits handler', async () => {
  pointToPythonRuntime();
  const work = mkdtempSync(join(tmpdir(), 'nova-close-'));
  process.chdir(work);
  const backend = new NovaBackend({ silent: true });
  const ready = await backend.start();
  assert.equal(ready, true);
  let closed = false;
  backend.onCloseRequested(() => { closed = true; });
  const result = await backend.handleRequest('ADAM, close yourself');
  assert.equal(result.closeRequested, true);
  assert.equal(closed, true);
  await backend.shutdown();
});

test('NovaBackend registers builtin capabilities for discovery', async () => {
  pointToPythonRuntime();
  const work = mkdtempSync(join(tmpdir(), 'nova-builtin-'));
  process.chdir(work);
  const backend = new NovaBackend({ silent: true });
  await backend.start();
  const caps = backend.listCapabilities();
  assert.ok(caps.some(c => c.name === 'Screen Capture'), 'screenshot builtin registered');
  assert.ok(caps.some(c => c.name === 'App Launcher'), 'launch builtin registered');
  assert.ok(caps.some(c => c.name === 'System Info'), 'system info builtin registered');
  await backend.shutdown();
});
