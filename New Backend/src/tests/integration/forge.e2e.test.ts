// End-to-end integration test — the REAL Tool Forge lifecycle.
//   capability missing -> design -> real Python source -> validation -> isolated
//   sandbox test -> registration -> persistence -> production execution ->
//   verification -> reuse after restart (no duplicate).
//
// This is NOT a mock: it forges a real File Scout Python tool, tests it in an
// isolated temp sandbox, registers it, executes it against a real directory,
// and verifies the result from actual filesystem metadata.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ToolLibrary } from '../../persistence/tool_library.js';
import { PythonRuntimeBridge } from '../../execution/PythonRuntimeBridge.js';
import { ValidationEngine } from '../../validation/ValidationEngine.js';
import { ToolTestingEngine } from '../../testing/ToolTestingEngine.js';
import { ProviderRegistry } from '../../providers/ProviderRegistry.js';
import { AgentSelector } from '../../reasoning/AgentSelector.js';
import { ToolForge } from '../../forge/ToolForge.js';
import { ExecutionEngine } from '../../execution/ExecutionEngine.js';
import { pointToPythonRuntime } from '../helpers.js';

function setup() {
  // Point the backend at the real python_runtime (tests chdir to a temp dir).
  pointToPythonRuntime();
  // chdir so Nova2Config lazily resolves userData/toolsRoot to a temp dir.
  const work = mkdtempSync(join(tmpdir(), 'nova-forge-e2e-'));
  process.chdir(work);
  const library = new ToolLibrary(work);
  const bridge = new PythonRuntimeBridge();
  const validator = new ValidationEngine(bridge);
  const tester = new ToolTestingEngine(bridge);
  const registry = new ProviderRegistry();
  const selector = new AgentSelector(registry);
  const forge = new ToolForge(library, selector, validator, tester);
  const executor = new ExecutionEngine(library, bridge);
  return { work, library, bridge, forge, executor };
}

test('forge: create -> validate -> sandbox test -> register -> execute -> verify -> reuse', async () => {
  const { work, library, forge, executor } = setup();

  // Real target directory with known files.
  const target = join(work, 'Data');
  mkdirSync(target);
  writeFileSync(join(target, 'small.txt'), 'hi');
  writeFileSync(join(target, 'big.txt'), 'x'.repeat(5000));
  writeFileSync(join(target, 'medium.txt'), 'y'.repeat(1000));

  // 1) Forge the missing capability (template path — no AI provider).
  const forged = await forge.forge('create a tool that reports the largest files in a directory');
  assert.equal(forged.reused, false, 'should create a new tool');
  const tool = library.getByTechnicalId(forged.tool.technicalId)!;
  assert.ok(tool.sourcePath, 'tool has a source path');
  assert.ok(tool.sourceCode?.includes('def run'), 'real python source present');
  assert.ok(tool.sourceHash.length === 64, 'sha256 checksum present');
  assert.equal(tool.version, '1.0.0');

  // Artifacts exist on disk.
  const fs = await import('node:fs');
  assert.ok(fs.existsSync(join(tool.sourcePath!, '..', 'manifest.json')));
  assert.ok(fs.existsSync(join(tool.sourcePath!, '..', 'tests', 'test_tool.py')));

  // 2) Production execution against the real directory.
  const result = await executor.executeTool(tool, { directory: target, n: 2 });
  assert.equal(result.success, true, result.error ?? '');
  const payload = result.payload as { largestFile: { name: string }; fileCount: number; largest: unknown[] };
  assert.equal(payload.fileCount, 3);
  assert.equal(payload.largestFile.name, 'big.txt', 'largest file must be big.txt');

  // 3) Rehydrate from disk into a fresh library -> tool reused, not duplicated.
  library.close(); // flush the registry store to disk (simulates clean shutdown)
  const fresh = new ToolLibrary(work);
  const report = fresh.hydrateFromDisk();
  const reuseTools = fresh.all().filter(t => t.technicalId === tool.technicalId);
  assert.equal(reuseTools.length, 1, 'exactly one File Scout tool after restart — no duplicate');
  const reused = fresh.getByTechnicalId(tool.technicalId);
  assert.ok(reused, 'tool persists across restart');
  assert.ok(reused.sourcePath && reused.sourcePath.length > 0, 'rehydrated tool has a source path');
  assert.equal(reused.version, '1.0.0');
  fresh.close();
});

test('forge: AI path with repair loop generates and registers a tool', async () => {
  const { library, forge, bridge } = setup();
  // Provide a fake coding provider that emits a valid ForgeDesign JSON.
  const fakeProvider = {
    id: 'fake-groq',
    label: 'Fake Groq',
    isConfigured: () => true,
    isAvailable: () => true,
    describe: () => ({}),
    async generate() {
      return JSON.stringify({
        displayName: 'Line Counter',
        technicalId: 'line_counter',
        description: 'counts the lines in a text file',
        category: 'files',
        capabilities: ['TEXT_ANALYSIS'],
        permissions: [{ type: 'fs-read', scope: ['*'] }],
        dependencies: [],
        pythonSource:
          'import os\n\ndef run(params):\n    p = str(params.get("path", "") or params.get("file", ""))\n    if not p or not os.path.isfile(p):\n        return {"success": False, "error": "no file"}\n    with open(p, "r", encoding="utf-8") as f:\n        n = sum(1 for _ in f)\n    return {"success": True, "path": p, "lineCount": n}\n',
        testSource:
          'import os, tempfile, sys\nsys.path.insert(0, ".")\nfrom tool import run\n\ndef t():\n    with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False) as f:\n        f.write("a\\nb\\nc\\n")\n        p = f.name\n    r = run({"path": p})\n    os.unlink(p)\n    assert r["success"] is True\n    assert r["lineCount"] == 3\n    print("ALL_TESTS_PASSED")\n\nt()\n',
      });
    },
  };
  // Rebuild selector with the fake registered.
  const registry = new ProviderRegistry();
  registry.register(fakeProvider as never);
  const selector = new AgentSelector(registry);
  const validator = new ValidationEngine(bridge);
  const tester = new ToolTestingEngine(bridge);
  const forgeAI = new ToolForge(library, selector, validator, tester);

  const forged = await forgeAI.forge('count the lines in a text file');
  const tool = library.getByTechnicalId('line_counter');
  assert.ok(tool, 'AI-forged tool registered under its technical id');
  assert.equal(tool.displayName, 'Line Counter');
  assert.ok(tool.sourcePath);
  assert.equal(tool.version, '1.0.0');
  library.close();
});
