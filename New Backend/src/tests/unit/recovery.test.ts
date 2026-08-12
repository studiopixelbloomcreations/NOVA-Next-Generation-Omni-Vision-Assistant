// Unit tests — Recovery Engine decision ladder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RecoveryEngine } from '../../recovery/RecoveryEngine.js';
import type { FailureReport } from '../../contracts/domain.js';

const recovery = new RecoveryEngine();

test('timeout retries then escalates to restart_worker', () => {
  const r1 = recovery.decide({ class: 'timeout', message: 'timed out', attempts: 1 });
  assert.equal(r1.action, 'retry');
  const r2 = recovery.decide({ class: 'timeout', message: 'timed out', attempts: 2 });
  assert.equal(r2.action, 'restart_worker');
  const r4 = recovery.decide({ class: 'timeout', message: 'timed out', attempts: 4 });
  assert.equal(r4.action, 'alternative_strategy');
});

test('tool_error retries then repairs then creates', () => {
  assert.equal(recovery.decide({ class: 'tool_error', message: 'boom', attempts: 1 }).action, 'retry');
  assert.equal(recovery.decide({ class: 'tool_error', message: 'boom', attempts: 2 }).action, 'repair_tool');
  assert.equal(recovery.decide({ class: 'tool_error', message: 'boom', attempts: 3 }).action, 'create_tool');
});

test('permission failure switches strategy immediately', () => {
  const d = recovery.decide({ class: 'permission', message: 'denied', attempts: 1 });
  assert.equal(d.action, 'alternative_strategy');
});

test('exhausted bound detection', () => {
  const report: FailureReport = { class: 'tool_error', message: 'x', attempts: 5 };
  assert.equal(recovery.exhausted(report), true);
});
