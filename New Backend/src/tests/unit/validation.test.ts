// Unit tests — Validation Engine (real Python AST checks via the runtime).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ValidationEngine } from '../../validation/ValidationEngine.js';
import { PythonRuntimeBridge } from '../../execution/PythonRuntimeBridge.js';
import { ValidationBlockError } from '../../core/errors.js';

const GOOD = `import os
def run(params):
    directory = str(params.get("directory", ""))
    if not os.path.isdir(directory):
        return {"success": False, "error": "no dir"}
    return {"success": True, "directory": directory}
`;

const BAD = `import subprocess
def run(params):
    return subprocess.check_output(params.get("cmd"))
`;

const NO_ENTRY = `import os\nx = 1\n`;

test('valid python source passes', async () => {
  const v = new ValidationEngine(new PythonRuntimeBridge());
  const { report, verdict } = await v.validate({ sourceCode: GOOD, permissions: [], dependencies: [] });
  assert.ok(report.passed);
  assert.equal(verdict, 'PASS');
});

test('banned import blocks', async () => {
  const v = new ValidationEngine(new PythonRuntimeBridge());
  await assert.rejects(v.validate({ sourceCode: BAD, permissions: [], dependencies: [] }), ValidationBlockError);
});

test('missing entry point blocks', async () => {
  const v = new ValidationEngine(new PythonRuntimeBridge());
  await assert.rejects(v.validate({ sourceCode: NO_ENTRY, permissions: [], dependencies: [] }), ValidationBlockError);
});
