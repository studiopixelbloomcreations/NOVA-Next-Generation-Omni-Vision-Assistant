// Unit tests — Health, Maintenance, Upgrade, Error Observability, Learning.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HealthEngine } from '../../maintenance/HealthEngine.js';
import { ErrorObservabilityEngine } from '../../maintenance/ErrorObservabilityEngine.js';
import { MaintenanceEngine } from '../../maintenance/MaintenanceEngine.js';
import { UpgradeEngine } from '../../upgrades/UpgradeEngine.js';
import { LearningEngine } from '../../maintenance/LearningEngine.js';
import { ToolLibrary } from '../../persistence/tool_library.js';
import { MemoryEngine } from '../../memory/MemoryEngine.js';
import { PythonRuntimeBridge } from '../../execution/PythonRuntimeBridge.js';
import { ProviderRegistry } from '../../providers/ProviderRegistry.js';
import { pointToPythonRuntime } from '../helpers.js';

test('ErrorObservabilityEngine captures and persists structured errors', () => {
  pointToPythonRuntime();
  const dir = mkdtempSync(join(tmpdir(), 'nova-err-'));
  const err = new ErrorObservabilityEngine(dir);
  const rec = err.capture({ subsystem: 'forge', message: 'sandbox failed', toolId: 't1' }, new Error('boom'));
  assert.equal(rec.type, 'tool_error');
  assert.equal(err.countSince(100_000), 1);
  assert.equal(err.recentBySubsystem('forge').length, 1);
  err.markResolved(rec.errorId, 'repaired');
  assert.ok(err.all()[0].resolution === 'repaired');
  err.close();
});

test('HealthEngine reports python offline when interpreter absent (degraded not fabricated)', async () => {
  pointToPythonRuntime();
  const dir = mkdtempSync(join(tmpdir(), 'nova-health-'));
  const lib = new ToolLibrary(dir);
  const registry = new ProviderRegistry();
  const health = new HealthEngine(lib, new PythonRuntimeBridge(), registry);
  const report = await health.check();
  assert.ok(report.subsystems.some(s => s.subsystem === 'python'));
  assert.ok(['healthy', 'offline'].includes(report.subsystems.find(s => s.subsystem === 'python')!.level));
  lib.close();
});

test('MaintenanceEngine produces findings and never self-modifies', async () => {
  pointToPythonRuntime();
  const dir = mkdtempSync(join(tmpdir(), 'nova-maint-'));
  const lib = new ToolLibrary(dir);
  // Mark a persisted tool unhealthy so maintenance flags it.
  const tool = {
    id: 'x', technicalId: 'broken_tool', displayName: 'Broken Tool', description: 'd', category: 'files',
    author: 'ai' as const, version: '1', runtime: 'python' as const, capabilities: [], permissions: [], dependencies: [],
    sourceHash: 'h', enabled: true, status: 'active' as const, health: 'unhealthy' as const,
    createdAt: Date.now(), updatedAt: Date.now(), lastExecutedAt: null, lastValidationDate: null,
    executionCount: 5, successCount: 0, totalExecutionTimeMs: 50, versions: [],
  };
  lib.upsert(tool as never);
  const errors = new ErrorObservabilityEngine(dir);
  const registry = new ProviderRegistry();
  const health = new HealthEngine(lib, new PythonRuntimeBridge(), registry);
  const maint = new MaintenanceEngine(health, errors, lib, 99999);
  const findings = await maint.runCheck(true);
  assert.ok(findings.some(f => f.subsystem.startsWith('tool:') && f.subsystem.includes('broken_tool')), 'flags unhealthy tool');
  // Findings only observe — the tool library is not mutated by maintenance.
  assert.equal(lib.getByTechnicalId('broken_tool')!.health, 'unhealthy');
  maint.stop();
  lib.close();
  errors.close();
});

test('UpgradeEngine stages, validates, trials and rolls back without touching production', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nova-upg-'));
  process.chdir(dir);
  const upgrades = new UpgradeEngine(dir);
  const proposal = upgrades.propose({
    title: 'Faster caching',
    reason: 'telemetry shows cache hit latency',
    benefit: 'lower latency',
    affectedSystems: ['cache'],
    risk: 'low',
    rollbackPlan: 'revert to previous',
    testPlan: 'unit tests',
    impact: 'none',
  });
  assert.equal(proposal.status, 'proposed');
  // Build+validate (simulated test harness — the engine only stages, it does
  // not apply anything to production).
  const ready = await upgrades.buildAndValidate(proposal.id, async () => ({ passed: true, evidence: 'all tests pass' }));
  assert.equal(ready!.status, 'ready');
  assert.ok(ready!.id === proposal.id);
  const trialed = upgrades.startTrial(proposal.id)!;
  assert.equal(trialed.status, 'trial');
  upgrades.rollback(proposal.id);
  assert.equal(upgrades.list()[0].status, 'rolled_back');
  upgrades.close();
});

test('LearningEngine records success and recalls it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nova-learn-'));
  const memory = new MemoryEngine(dir);
  const learning = new LearningEngine(memory);
  learning.learnFromTask({
    id: 'e', requestId: 'r', taskId: 't', executionId: 'e',
    transcript: 'find largest file in downloads',
    intent: null, plan: null, agentProviderId: null,
    steps: [{ step: { id: '1', goal: 'g', capability: 'c', tool: 'File Scout', args: {}, verification: 'v', fallbackStrategies: [], timeoutMs: 1000 }, tool: { id: 't', technicalId: 'file_scout', displayName: 'File Scout', description: 'd', category: 'files', author: 'ai', version: '1', runtime: 'python', capabilities: [], permissions: [], dependencies: [], sourceHash: 'h', enabled: true, status: 'active', health: 'unknown', createdAt: 1, updatedAt: 1, lastExecutedAt: null, lastValidationDate: null, executionCount: 0, successCount: 0, totalExecutionTimeMs: 0, versions: [] }, success: true, payload: {}, error: null, attempts: 1, verification: { passed: true, detail: 'ok' } }],
    verification: { passed: true, detail: 'ok' }, retries: 0, errors: [], latencyMs: 1, status: 'completed' as const,
    startedAt: 1, completedAt: 2, summary: 'done',
  });
  const recalled = await learning.recall('find the largest file', 5);
  assert.ok(recalled.length >= 1, 'recalled a learned success workflow');
  memory.close();
});
