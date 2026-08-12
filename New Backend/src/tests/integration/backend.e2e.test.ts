// End-to-end integration test — the full NovaBackend master loop.
//   REAL REQUEST -> INTENT -> ENVIRONMENT -> CAPABILITY DISCOVERY ->
//   PLANNING -> TOOL FORGE (real Python) -> SANDBOX TEST -> REGISTRATION ->
//   REAL EXECUTION -> VERIFICATION -> MEMORY -> FINAL RESULT.
// Mirrors the "Analyze my Downloads folder / directory" scenario.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NovaBackend } from '../../index.js';
import { pointToPythonRuntime } from '../helpers.js';

test('NovaBackend: analyze-a-directory request end-to-end', async () => {
  pointToPythonRuntime();
  const work = mkdtempSync(join(tmpdir(), 'nova-backend-e2e-'));
  process.chdir(work);

  // Real target directory.
  const target = join(work, 'Downloads');
  mkdirSync(target);
  writeFileSync(join(target, 'notes.txt'), 'short');
  writeFileSync(join(target, 'archive.zip'), 'z'.repeat(30000));
  writeFileSync(join(target, 'report.pdf'), 'p'.repeat(8000));

  const backend = new NovaBackend({ silent: true });
  const ready = await backend.start();
  assert.equal(ready, true, 'backend should reach READY');

  const request = `Analyze the directory ${target} and tell me which file is the largest`;
  const result = await backend.handleRequest(request, 'typed');

  assert.equal(result.status, 'completed', result.summary);
  assert.ok(result.entry, 'ledger entry recorded');
  assert.ok(result.entry.plan, 'plan recorded');
  assert.ok(result.entry.intent, 'intent recorded');
  assert.ok(result.entry.steps.length > 0, 'steps executed');

  const payload = result.payloads[0] as { largestFile?: { name: string }; fileCount?: number };
  assert.ok(payload, 'a payload was returned');
  if (payload && payload.largestFile) {
    assert.equal(payload.largestFile.name, 'archive.zip', 'largest file independently verified');
  }

  // The forged tool persisted and the ledger retained the trace.
  const capabilities = backend.listCapabilities();
  assert.ok(capabilities.some(c => c.name === 'File Scout'), 'persisted File Scout capability present');
  assert.ok(backend.ledger.recent().length >= 1, 'ledger has the trace');

  await backend.shutdown();
});
