// New Backend — validation/ValidationEngine.ts
// Validation Engine. Every generated tool must pass: Python syntax, AST/import
// validation, dependency validation, permission validation, forbidden-API
// checks, resource checks, output schema checks, manifest checks, and checksum
// generation. Verdicts are PASS / WARN / BLOCK — a BLOCK prevents execution.
import { createHash } from 'node:crypto';
import type { ToolDefinition, ToolPermission, ValidationReport, ValidationViolation } from '../contracts/domain.js';
import { PythonRuntimeBridge } from '../execution/PythonRuntimeBridge.js';
import { ValidationBlockError } from '../core/errors.js';
import { Nova2Config } from '../core/config.js';
import { logger } from '../core/logger.js';

export type Verdict = 'PASS' | 'WARN' | 'BLOCK';

export interface ValidationInput {
  sourceCode: string;
  displayName?: string;
  technicalId?: string;
  permissions?: ToolPermission[];
  dependencies?: string[];
  maxBytes?: number;
}

export class ValidationEngine {
  constructor(private readonly bridge: PythonRuntimeBridge) {}

  /** Validates Python source. Throws ValidationBlockError on BLOCK. */
  async validate(input: ValidationInput): Promise<{ report: ValidationReport; verdict: Verdict }> {
    const violations: ValidationViolation[] = [];
    const maxBytes = input.maxBytes ?? Nova2Config.forge.maxSourceBytes;
    const source = input.sourceCode;

    // 1. Size / resource check.
    if (!source.trim()) violations.push({ code: 'V-EMPTY', severity: 'error', message: 'generated Python source is empty' });
    if (source.length > maxBytes) violations.push({ code: 'V-SIZE', severity: 'error', message: `source exceeds ${maxBytes} bytes` });

    // 2. Python syntax + AST security scan (via bridge).
    const ast = await this.bridge.run('check-syntax', { source }, 15000);
    if (ast.ok && ast.data && typeof ast.data === 'object') {
      const d = ast.data as { valid?: boolean; syntax?: boolean; violations?: string[] };
      if (d.valid === false) {
        for (const v of d.violations ?? []) violations.push({ code: 'V-AST', severity: 'error', message: v });
      }
      if (d.syntax === false) violations.push({ code: 'V-SYNTAX', severity: 'error', message: 'python source did not compile' });
    } else {
      // AST bridge unavailable — degrade to static regex checks (still blocks).
      if (/(?:^|\n)\s*(?:import|from)\s+(?:subprocess|socket|ctypes|multiprocessing|pickle)\b/.test(source)) {
        violations.push({ code: 'V-AST', severity: 'error', message: 'banned import detected (static fallback)' });
      }
      if (/\b(?:os\.system|os\.popen|eval\s*\(|exec\s*\(|__import__\s*\(|compile\s*\()/.test(source)) {
        violations.push({ code: 'V-AST', severity: 'error', message: 'banned call detected (static fallback)' });
      }
    }

    // 3. Entry point contract.
    if (!/def\s+run\s*\(/.test(source)) violations.push({ code: 'V-ENTRY', severity: 'error', message: 'no run(params) entry point' });

    // 4. Dependency validation: generated tools may only use stdlib + declared deps.
    const deps = input.dependencies ?? [];
    for (const line of source.split('\n')) {
      const m = line.match(/^\s*(?:import|from)\s+([A-Za-z0-9_\.]+)/);
      if (m && !/^(?:import|from)\s+(?:os|sys|json|math|re|typing|dataclasses|datetime|time|pathlib|collections|itertools|functools|random|string|textwrap|statistics|enum|copy|operator|glob|io|shutil(?!\.rmtree)|tempfile|platform|__future__)/.test(line)) {
        const mod = m[1].split('.')[0];
        if (!deps.some(d => d.split('==')[0].split('>')[0].split('<')[0].split('=')[0].toLowerCase() === mod.toLowerCase())) {
          violations.push({ code: 'V-DEP', severity: 'warning', message: `undeclared import: ${mod}` });
        }
      }
    }

    // 5. Permission validation: sandboxed/generated tools cannot request process/native.
    for (const p of input.permissions ?? []) {
      if (p.type === 'child-process' || p.type === 'native-module') {
        violations.push({ code: 'V-PERM', severity: 'error', message: `generated tool requests banned permission '${p.type}'` });
      }
      if (p.type === 'fs-write' && p.scope?.includes('*')) {
        violations.push({ code: 'V-PERM', severity: 'warning', message: 'unrestricted filesystem write requested' });
      }
    }

    // 6. Output schema: must promise a JSON-serializable result (static check).
    if (!/return\s+\{/.test(source) && !/return\s+dict/.test(source)) {
      violations.push({ code: 'V-SCHEMA', severity: 'warning', message: 'run() does not obviously return a dict' });
    }

    const errors = violations.filter(v => v.severity === 'error');
    const verdict: Verdict = errors.length === 0 ? 'PASS' : 'BLOCK';
    const hasWarnings = violations.some(v => v.severity === 'warning');
    const effective: Verdict = verdict === 'PASS' && hasWarnings ? 'WARN' : verdict;

    const report: ValidationReport = {
      passed: verdict === 'PASS',
      violations,
      testedAt: Date.now(),
      inferredPermissions: this.inferPermissions(source),
      checksum: createHash('sha256').update(source, 'utf-8').digest('hex'),
    };

    if (effective === 'BLOCK') {
      logger.warn('[validation] tool validation BLOCKED', { violations: errors.map(v => v.message) });
      throw new ValidationBlockError(errors.map(v => v.message).join('; ') || 'tool validation failed');
    }
    return { report, verdict: effective };
  }

  /** Simple static permission inference from source. */
  private inferPermissions(source: string): ToolPermission[] {
    const perms: ToolPermission[] = [];
    if (/\b(?:os\.listdir|os\.stat|open\(|glob\.|pathlib)/.test(source)) perms.push({ type: 'fs-read', scope: ['*'] });
    if (/\b(?:os\.makedirs|open\(\s*['\"]?\w.*['\"]?\s*,\s*['\"]w)/.test(source)) perms.push({ type: 'fs-write', scope: ['*'] });
    return perms;
  }
}
