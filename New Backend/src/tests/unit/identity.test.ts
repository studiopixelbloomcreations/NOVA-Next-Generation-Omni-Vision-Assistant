// Unit tests — A.D.A.M. identity migration + Personality/Output engines.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Identity, toAdamIdentity } from '../../contracts/identity.js';
import { SettingsStore } from '../../persistence/settings_store.js';
import { PersonalityEngine } from '../../reasoning/PersonalityEngine.js';
import { OutputEngine } from '../../reasoning/OutputEngine.js';
import type { ExecutionLedgerEntry } from '../../contracts/domain.js';

test('canonical identity constants are A.D.A.M. / ADAM', () => {
  assert.equal(Identity.name, 'A.D.A.M.');
  assert.equal(Identity.spokenName, 'ADAM');
  assert.equal(Identity.wakeWord, 'ADAM');
  assert.equal(Identity.voice, 'Charon');
  assert.equal(Identity.formOfAddress, 'Sir');
  assert.ok(!Identity.wakeWord.includes('NOVA'));
});

test('toAdamIdentity rebrands runtime NOVA references but not NOVA Core pattern oddly', () => {
  assert.equal(toAdamIdentity('NOVA Genesis Tool Forge'), 'A.D.A.M. Tool Forge');
  assert.equal(toAdamIdentity('inside NOVA Genesis'), 'inside A.D.A.M.');
  // "NOVA Core" becomes "A.D.A.M. Core".
  assert.equal(toAdamIdentity('NOVA Core executes'), 'A.D.A.M. Core executes');
});

test('PersonalityEngine preserves facts and uses Sir address', () => {
  const settings = new SettingsStore(mkdtempSync(join(tmpdir(), 'nova-pers-')));
  const engine = new PersonalityEngine(settings);
  assert.equal(engine.getAddress(), 'Sir');
  const out = engine.transform('NOVA Genesis completed the task.');
  assert.ok(out.includes('A.D.A.M.'));
  assert.ok(out.includes('completed the task.'), 'facts preserved');
});

test('OutputEngine surfaces the important result', () => {
  const settings = new SettingsStore(mkdtempSync(join(tmpdir(), 'nova-out-')));
  const personality = new PersonalityEngine(settings);
  const output = new OutputEngine(personality);
  const entry: ExecutionLedgerEntry = {
    id: 'e1', requestId: 'r', taskId: 't', executionId: 'e1',
    transcript: 'find largest file',
    intent: null, plan: null, agentProviderId: null,
    steps: [{
      step: { id: '1', goal: 'analyze', capability: 'x', tool: 'File Scout', args: {}, verification: 'ok', fallbackStrategies: [], timeoutMs: 30000 },
      tool: { id: 't', technicalId: 'file_scout', displayName: 'File Scout', description: 'd', category: 'files', author: 'ai', version: '1', runtime: 'python', capabilities: [], permissions: [], dependencies: [], sourceHash: 'h', enabled: true, status: 'active', health: 'unknown', createdAt: 1, updatedAt: 1, lastExecutedAt: null, lastValidationDate: null, executionCount: 1, successCount: 1, totalExecutionTimeMs: 10, versions: [] },
      success: true, payload: { success: true, largestFile: { name: 'big.zip', sizeBytes: 5000 } }, error: null, attempts: 1,
      verification: { passed: true, detail: 'ok' },
    }],
    verification: { passed: true, detail: 'ok' },
    retries: 0, errors: [], latencyMs: 10, status: 'completed', startedAt: 1, completedAt: 2, summary: 'done',
  };
  const text = output.compose(entry);
  assert.ok(text.includes('big.zip'), 'surfaces the largest file');
  assert.ok(text.toLowerCase().includes('verified'), 'mentions verification');
});
