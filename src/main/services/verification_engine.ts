// NOVA Verification Engine.
// Independent objective checks for forged-tool lifecycle completion.
import * as fs from 'fs';
import * as crypto from 'crypto';
import { ToolDefinition } from './tool_types';
import { ToolRegistry } from './tool_registry';

export interface VerificationResult {
  passed: boolean;
  checks: Array<{ name: string; passed: boolean; detail: string }>;
  summary: string;
}

export class VerificationEngine {
  constructor(private readonly registry: ToolRegistry) {}

  verifyTool(tool: ToolDefinition, executionPayload: unknown): VerificationResult {
    const checks: VerificationResult['checks'] = [];
    const registered = this.registry.get(tool.id);
    checks.push({ name: 'registry-registration', passed: !!registered, detail: registered ? 'tool is present in the live registry' : 'tool is not present in the live registry' });

    const sourceExists = !!tool.sourcePath && fs.existsSync(tool.sourcePath);
    checks.push({ name: 'python-source-exists', passed: sourceExists, detail: sourceExists ? String(tool.sourcePath) : 'registered Python source file is missing' });

    let hashOk = false;
    if (sourceExists && tool.sourcePath) {
      try {
        const hash = crypto.createHash('sha256').update(fs.readFileSync(tool.sourcePath)).digest('hex');
        hashOk = hash === tool.sourceHash;
      } catch { hashOk = false; }
    }
    checks.push({ name: 'source-integrity', passed: hashOk, detail: hashOk ? 'SHA-256 matches registry metadata' : 'source hash mismatch or source unavailable' });

    const resultObject = executionPayload !== null && typeof executionPayload === 'object';
    checks.push({ name: 'structured-result', passed: resultObject, detail: resultObject ? 'production execution returned a structured result' : 'production execution returned no structured result' });

    const success = resultObject && (executionPayload as Record<string, unknown>).success !== false;
    checks.push({ name: 'execution-result', passed: success, detail: success ? 'production result did not report failure' : String((executionPayload as Record<string, unknown>).error ?? 'production result reported failure') });

    const passed = checks.every(c => c.passed);
    return { passed, checks, summary: passed ? 'All objective tool checks passed.' : checks.filter(c => !c.passed).map(c => `${c.name}: ${c.detail}`).join('; ') };
  }
}
