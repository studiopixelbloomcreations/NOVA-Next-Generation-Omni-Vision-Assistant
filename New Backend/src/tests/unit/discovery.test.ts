// Unit tests — Capability Discovery Engine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ToolLibrary } from '../../persistence/tool_library.js';
import { CapabilityDiscoveryEngine } from '../../capability/CapabilityDiscoveryEngine.js';
import type { ToolDefinition } from '../../contracts/domain.js';

function makeTool(over: Partial<ToolDefinition>): ToolDefinition {
  return {
    id: 'id',
    technicalId: 'file_scout',
    displayName: 'File Scout',
    description: 'Reports the largest files in a directory',
    category: 'files',
    author: 'ai',
    version: '1.0.0',
    runtime: 'python',
    capabilities: ['DIRECTORY_ANALYSIS', 'FILE_SCOUT'],
    permissions: [],
    dependencies: [],
    sourceHash: 'abc',
    enabled: true,
    status: 'active',
    health: 'unknown',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    lastExecutedAt: null,
    lastValidationDate: null,
    executionCount: 0,
    successCount: 0,
    totalExecutionTimeMs: 0,
    versions: [],
    ...over,
  };
}

test('discovers a matching capability semantically', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nova-disc-'));
  const lib = new ToolLibrary(dir);
  lib.upsert(makeTool({}));
  const discovery = new CapabilityDiscoveryEngine(lib);
  const r = discovery.discover('which files are the largest in my directory');
  assert.equal(r.found, true);
  assert.ok(r.best);
  assert.equal(r.best.toolName, 'File Scout');
});

test('no strong match returns found=false', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nova-disc-'));
  const lib = new ToolLibrary(dir);
  lib.upsert(makeTool({}));
  const discovery = new CapabilityDiscoveryEngine(lib);
  const r = discovery.discover('what is the weather in Paris');
  assert.equal(r.found, false);
  lib.close();
});
