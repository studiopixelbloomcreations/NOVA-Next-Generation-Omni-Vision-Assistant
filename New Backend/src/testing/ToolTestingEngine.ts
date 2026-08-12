// New Backend — testing/ToolTestingEngine.ts
// Tool Testing Engine. Runs generated tests inside an ISOLATED sandbox (temp
// dir subprocess, scrubbed env, hard timeout). Sandbox testing is validation
// only — it never touches the real user system for production actions.
import { PythonRuntimeBridge } from '../execution/PythonRuntimeBridge.js';
import { Nova2Config } from '../core/config.js';
import { SandboxTestFailureError } from '../core/errors.js';

export interface SandboxTestOutcome {
  passed: boolean;
  output: string;
}

export class ToolTestingEngine {
  constructor(private readonly bridge: PythonRuntimeBridge) {}

  async runSandboxTest(toolPath: string, testPath: string): Promise<SandboxTestOutcome> {
    const timeoutMs = Nova2Config.forge.sandboxTestTimeoutMs;
    const result = await this.bridge.sandboxTest(toolPath, testPath, timeoutMs);
    if (!result.ok) {
      throw new SandboxTestFailureError(result.error ?? 'sandbox test could not run');
    }
    const data = result.data as { passed?: boolean; output?: string } | null;
    return { passed: data?.passed === true, output: data?.output ?? '' };
  }
}
