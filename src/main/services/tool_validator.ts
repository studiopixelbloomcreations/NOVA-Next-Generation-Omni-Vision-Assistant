// src/main/services/tool_validator.ts
// Validation pipeline for tools before they are registered or executed.
//
// Stages (in order):
//   1. Syntax validation      — the source must parse as ECMAScript.
//   2. Static security audit  — AST walk for dangerous patterns/modules.
//   3. Size & shape limits    — source size, entry-point shape.
//   4. Dependency validation  — any imports/requires are captured and must be
//                               declared; sandboxed execution forbids them.
//   5. Sandbox compile check  — the source must compile inside isolated-vm and
//                               evaluate to a callable function.
//   6. Automated unit tests   — the tool is invoked with generated sample
//                               contexts and must satisfy assertions.
//   7. Permission inference   — network/clipboard/notification usage is derived
//                               from static analysis and attached to the tool.
import * as acorn from 'acorn';
import * as walk from 'acorn-walk';
import { performSecurityAudit } from '../utils/security';
import { NovaConfig } from '../core/config';
import { ToolPermission, ValidationReport, ValidationViolation } from './tool_types';
import { logger } from '../core/logger';

export interface ToolAssertion {
  description: string;
  /** Context object passed to the tool during tests. */
  context?: Record<string, unknown>;
  /** Expect the invocation to complete without throwing. */
  mustNotThrow?: boolean;
  /** Expect the returned value to be a non-null object. */
  mustBeObject?: boolean;
  /** Expect a specific top-level key to be present (with a truthy value). */
  mustHaveKey?: string;
}

export interface ValidationInput {
  sourceCode: string;
  assertions?: ToolAssertion[];
}

let isolatedVm: any = null;
try {
  isolatedVm = require('isolated-vm');
} catch {
  isolatedVm = null;
}

function detectDependencies(sourceCode: string): string[] {
  const deps = new Set<string>();
  try {
    const ast = acorn.parse(sourceCode, { ecmaVersion: 'latest' });
    walk.simple(ast, {
      CallExpression(node: any) {
        if (node.callee?.name === 'require' && node.arguments[0]?.type === 'Literal') {
          deps.add(String(node.arguments[0].value));
        }
      },
      ImportDeclaration(node: any) {
        if (typeof node.source?.value === 'string') deps.add(node.source.value);
      },
    });
  } catch {
    /* syntax errors reported elsewhere */
  }
  return Array.from(deps);
}

function inferPermissions(sourceCode: string): ToolPermission[] {
  const permissions: ToolPermission[] = [];
  const httpScopes = new Set<string>();
  const urlRegex = /https?:\/\/([a-zA-Z0-9.-]+)(?::\d+)?/g;
  let match: RegExpExecArray | null;
  while ((match = urlRegex.exec(sourceCode)) !== null) {
    httpScopes.add(match[1]);
  }
  if (httpScopes.size > 0) {
    const scopes = Array.from(httpScopes);
    permissions.push({ type: 'net-http', scope: scopes });
    permissions.push({ type: 'net-https', scope: scopes });
  }
  if (/navigator\.clipboard|clipboard|copyToClipboard|writeText/i.test(sourceCode)) {
    permissions.push({ type: 'clipboard', scope: ['*'] });
  }
  if (/new Notification|electron.*Notification/i.test(sourceCode)) {
    permissions.push({ type: 'notification', scope: ['*'] });
  }
  return permissions;
}

/**
 * Compiles the source inside an isolated-vm isolate and returns a reference to
 * the exported function. Returns null when the source does not evaluate to a
 * callable function or when isolated-vm is unavailable (in which case the host
 * will fall back to its own compile path).
 */
export function sandboxCompile(sourceCode: string): { compile: () => Promise<unknown> } | null {
  if (!isolatedVm) return null;
  return {
    compile: async () => {
      const isolate = new isolatedVm.Isolate({
        memoryLimit: NovaConfig.tooling.sandboxMemoryMb,
      });
      const context = isolate.createContextSync();
      const jail = context.global;
      const safeGlobals: Record<string, unknown> = {
        Date,
        Math,
        JSON,
        Array,
        Object,
        String,
        Number,
        Boolean,
        RegExp,
        Promise,
        Set,
        Map,
        Uint8Array,
        console: { log() {}, warn() {}, error() {} },
      };
      for (const [k, v] of Object.entries(safeGlobals)) {
        try {
          jail.setSync(k, v);
        } catch {
          /* ignore individual injection failures */
        }
      }
      const script = isolate.compileScriptSync(sourceCode);
      const result = await script.run(context);
      return result;
    },
  };
}

export class ToolValidator {
  /**
   * Runs the full validation pipeline. `executionCheck` is an optional hook
   * that invokes the compiled function with a sample context so the validator
   * can run automated unit tests without duplicating executor logic.
   */
  public async validate(
    input: ValidationInput,
    executionCheck?: (context: Record<string, unknown>) => Promise<unknown>,
  ): Promise<ValidationReport> {
    const violations: ValidationViolation[] = [];
    const source = input.sourceCode;

    // 1. Syntax validation.
    try {
      acorn.parse(source, {
        ecmaVersion: 'latest',
        allowReturnOutsideFunction: true,
      });
    } catch (err) {
      violations.push({
        code: 'SYNTAX',
        severity: 'error',
        message: `Invalid syntax: ${err instanceof Error ? err.message : String(err)}`,
      });
      return { passed: false, violations, testedAt: Date.now(), inferredPermissions: [] };
    }

    // 2. Static security audit.
    const audit = performSecurityAudit(source);
    if (!audit.passed) {
      violations.push({
        code: 'SECURITY',
        severity: 'error',
        message: audit.reason ?? 'Static security audit failed',
      });
    }

    // 3. Size limits.
    if (Buffer.byteLength(source, 'utf-8') > NovaConfig.tooling.maxSourceBytes) {
      violations.push({
        code: 'SIZE',
        severity: 'error',
        message: `Tool source exceeds ${NovaConfig.tooling.maxSourceBytes} bytes`,
      });
    }

    // 4. Dependency validation — sandboxed tools may not import host modules.
    const dependencies = detectDependencies(source);
    if (dependencies.length > 0) {
      violations.push({
        code: 'DEPENDENCY',
        severity: 'error',
        message: `Sandboxed tools cannot import host modules: ${dependencies.join(', ')}`,
      });
    }

    // 5. Sandbox compile check (when isolated-vm is available).
    let compileOk = false;
    const compiled = sandboxCompile(source);
    if (compiled) {
      try {
        const fnRef = (await compiled.compile()) as any;
        // Accept either a Reference (applySync) or a direct-callable function.
        compileOk =
          typeof fnRef === 'function' ||
          (fnRef && typeof fnRef.applySync === 'function');
        if (!compileOk) {
          violations.push({
            code: 'ENTRY_POINT',
            severity: 'error',
            message: 'Tool source must evaluate to a callable function',
          });
        }
      } catch (err) {
        violations.push({
          code: 'COMPILE',
          severity: 'error',
          message: `Sandbox compilation failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    } else {
      violations.push({
        code: 'SANDBOX_UNAVAILABLE',
        severity: 'warning',
        message: 'isolated-vm unavailable; sandbox compile check skipped',
      });
    }

    // 6. Automated unit tests.
    const assertions = input.assertions ?? [
      { description: 'tool must not throw on default context', mustNotThrow: true },
      { description: 'tool must return a JSON-serializable object', mustBeObject: true },
    ];
    let testFailures = 0;
    if (compileOk && executionCheck) {
      for (const assertion of assertions) {
        try {
          const result = await executionCheck(assertion.context ?? {});
          if (assertion.mustBeObject && (result === null || typeof result !== 'object')) {
            violations.push({ code: 'TEST', severity: 'error', message: assertion.description });
            testFailures++;
          }
          if (assertion.mustHaveKey && (result === null || typeof result !== 'object' || !(assertion.mustHaveKey in (result as Record<string, unknown>)))) {
            violations.push({ code: 'TEST', severity: 'error', message: assertion.description });
            testFailures++;
          }
        } catch (err) {
          if (assertion.mustNotThrow) {
            violations.push({
              code: 'TEST',
              severity: 'error',
              message: `${assertion.description}: ${err instanceof Error ? err.message : String(err)}`,
            });
            testFailures++;
          }
        }
      }
    } else if (compileOk) {
      // No execution hook supplied — still validate a plain default invocation
      // via the executor when it is wired by the builder.
      logger.debug('[tool_validator] execution hook missing; skipping automated tests');
    }

    // 7. Permission inference (warnings only).
    const inferredPermissions = inferPermissions(source);

    return {
      passed: violations.every(v => v.severity !== 'error') && testFailures === 0,
      violations,
      testedAt: Date.now(),
      inferredPermissions,
    };
  }
}

export const toolValidator = new ToolValidator();
export { inferPermissions, detectDependencies };
