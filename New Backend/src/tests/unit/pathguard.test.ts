// Unit tests — PathGuard sandbox enforcement.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { PathGuard } from '../../security/path_guard.js';
import { PathEscapeError } from '../../core/errors.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

test('resolveInside permits paths inside the sandbox root', () => {
  const root = mkdtempSync(join(tmpdir(), 'nova-sandbox-'));
  const guard = new PathGuard([root]);
  const p = guard.resolveInside(root, 'sub/tool.py');
  assert.ok(p.startsWith(root));
});

test('resolveInside blocks escapes', () => {
  const root = mkdtempSync(join(tmpdir(), 'nova-sandbox-'));
  const guard = new PathGuard([root]);
  assert.throws(() => guard.resolveInside(root, '../../etc/passwd'), PathEscapeError);
});

test('resolveHostPath restricts to Desktop/Documents/Downloads', () => {
  const guard = new PathGuard([join(tmpdir(), 'nova-guard')]);
  // Absolute path outside allowed roots is rejected.
  assert.throws(() => guard.resolveHostPath('/tmp/somewhere'), PathEscapeError);
});
