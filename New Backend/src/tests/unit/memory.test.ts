// Unit tests — Memory Engine (persistence + relevant retrieval + sanitization).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryEngine } from '../../memory/MemoryEngine.js';

test('memory stores and persists entries', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nova-mem-'));
  const mem = new MemoryEngine(dir);
  mem.add('preference', 'The user prefers reports in Markdown', ['preference', 'markdown']);
  mem.close();

  const mem2 = new MemoryEngine(dir);
  assert.equal(mem2.recent().length, 1);
  mem2.close();
});

test('relevant retrieval ranks matching entries first', async () => {
  const mem = new MemoryEngine(mkdtempSync(join(tmpdir(), 'nova-mem-')));
  mem.add('project', 'NOVA video renderer project uses WebGL waveform', ['video', 'webgl']);
  mem.add('project', 'Daily AI news digest is saved to Desktop', ['news', 'research']);
  const results = await mem.search('AI news summary', 5);
  assert.ok(results.length > 0);
  assert.ok(results.some(e => e.tags.includes('news') || e.content.includes('news')));
});

test('secrets are scrubbed before storage', () => {
  const mem = new MemoryEngine(mkdtempSync(join(tmpdir(), 'nova-mem-')));
  const e = mem.add('fact', 'my token is ghp_abcdefghijklmnopqrstuvwxyz123456 keep safe', ['secret']);
  assert.ok(!e.content.includes('ghp_abcdefghijklmnopqrstuvwxyz123456'));
});
