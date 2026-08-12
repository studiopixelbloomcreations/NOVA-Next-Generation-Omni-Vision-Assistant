// Unit tests — Execution Ledger duplicate prevention + persistence.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExecutionLedger } from '../../persistence/execution_ledger.js';
import type { ExecutionLedgerEntry } from '../../contracts/domain.js';

function makeEntry(requestId: string): ExecutionLedgerEntry {
  const ids = { id: 'e1', requestId, taskId: 't', executionId: 'e1' };
  return {
    id: ids.id,
    requestId,
    taskId: 't1',
    executionId: 'e1',
    transcript: 'test request',
    intent: null,
    plan: null,
    agentProviderId: null,
    steps: [],
    verification: { passed: true, detail: 'ok' },
    retries: 0,
    errors: [],
    latencyMs: 10,
    status: 'completed',
    startedAt: Date.now(),
    completedAt: Date.now(),
    summary: 'done',
  };
}

test('duplicate requestId detection prevents double execution', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nova-ledger-'));
  const ledger = new ExecutionLedger(dir);
  ledger.save(makeEntry('req-1'));
  assert.equal(ledger.isExecuted('req-1'), true);
  assert.equal(ledger.isExecuted('req-999'), false);
  ledger.close();
});

test('ledger persists across reopen', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nova-ledger-'));
  const a = new ExecutionLedger(dir);
  a.save(makeEntry('req-persist'));
  a.close();
  const b = new ExecutionLedger(dir);
  assert.equal(b.isExecuted('req-persist'), true);
  assert.equal(b.all().length, 1);
  b.close();
});
