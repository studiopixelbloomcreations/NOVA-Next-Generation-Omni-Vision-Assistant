// src/main/utils/security.ts
import { EventEmitter } from 'events';
import * as acorn from 'acorn';
import * as walk from 'acorn-walk';

export { PiiSanitizer } from '../services/pii_sanitizer';

/**
 * Environment variables that hold API keys or other secrets. Child processes
 * must never inherit these: we always pass an explicit, scrubbed environment
 * to spawn().
 */
export const SECRET_ENV_KEYS: ReadonlySet<string> = new Set([
  'GEMINI_API_KEY',
  'GROQ_API_KEY',
  'PICOVOICE_ACCESS_KEY',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'ELEVENLABS_API_KEY',
  'LITELLM_MASTER_KEY',
  'LITELLM_API_KEY',
  'HF_TOKEN',
  'HUGGING_FACE_HUB_TOKEN',
  'AZURE_OPENAI_KEY',
  'REPLICATE_API_TOKEN',
]);

/**
 * Returns a copy of the given environment with every known secret removed.
 * Use this as the `env` option for every spawn() so API keys never reach
 * child processes (ffmpeg, Python, PowerShell, launched apps).
 */
export function scrubEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const copy: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && !SECRET_ENV_KEYS.has(key)) {
      copy[key] = value;
    }
  }
  return copy;
}

// TLS 1.3 Note: The `ws` library supports TLS 1.3 on Node 16+.
// No code change is required for WebSocket TLS in this runtime.

// Security audit function used by AgentOrchestrator
export function performSecurityAudit(code: string): { passed: boolean; reason?: string } {
  const BLOCKED_KEYWORDS: string[] = [
    'process.exit',
    'process.env',
    'fs.rmSync',
    'fs.unlinkSync',
    'fs.rmdirSync',
    'child_process',
    'require(',
    'eval(',
    'Function(',
    'globalThis',
    'process.mainModule',
    'process.binding',
    'process.dlopen',
    'vm.runInContext',
    'vm.runInNewContext',
    'vm.createContext',
  ];

  // Loop guards: catches `while(true)`, `while(1)`, `for(;;)`, any `for(;;)`
  // variant with an empty condition section, and `do{}while(1|true)`. These
  // matter because the sandbox cannot preempt a synchronous runaway loop.
  const INFINITE_LOOP_PATTERNS: RegExp[] = [
    /while\s*\(\s*(?:1|true)\s*\)/,
    /for\s*\([^;]*;\s*;[^)]*\)/,
    /do\s*\{[\s\S]*?\}\s*while\s*\(\s*(?:1|true)\s*\)/,
  ];

  // Check for blocked keywords
  for (const keyword of BLOCKED_KEYWORDS) {
    if (code.includes(keyword)) {
      return { passed: false, reason: `Blocked keyword detected: "${keyword}"` };
    }
  }

  // Check for infinite loop patterns
  for (const pattern of INFINITE_LOOP_PATTERNS) {
    if (pattern.test(code)) {
      return { passed: false, reason: `Potential infinite loop detected: ${pattern.source}` };
    }
  }

  // AST-based static analysis
  try {
    const ast = acorn.parse(code, {
      ecmaVersion: 'latest',
      sourceType: 'module',
      allowReturnOutsideFunction: true,
      allowAwaitOutsideFunction: true,
    });

    // Direct self-recursion is rejected: a generated one-shot tool must
    // terminate, and recursion is the standard way to bypass loop guards.
    // This is intentionally conservative — a closure that merely references
    // the outer function name without recursing is also rejected.
    let recursionViolation: string | null = null;
    walk.simple(ast, {
      FunctionDeclaration(node: any) {
        if (!node.id?.name) return;
        walk.simple(node.body, {
          CallExpression(call: any) {
            if (call.callee?.type === 'Identifier' && call.callee.name === node.id.name) {
              recursionViolation = `Self-recursive function detected: ${node.id.name}`;
            }
          },
        });
      },
    });
    if (recursionViolation) {
      throw new Error(recursionViolation);
    }

    // Walk the AST and check for dangerous patterns
    walk.simple(ast, {
      CallExpression(node: any) {
        // Check for dangerous function calls
        if (node.callee.type === 'Identifier') {
          const dangerousFunctions = [
            'eval',
            'Function',
            'setTimeout',
            'setInterval',
            'setImmediate',
            'process.exit',
            'process.kill',
            'process.killProcess',
          ];
          if (dangerousFunctions.includes(node.callee.name)) {
            throw new Error(`Dangerous function call detected: ${node.callee.name}`);
          }
        }
        // Check for require() calls
        if (node.callee.name === 'require' && node.arguments.length > 0) {
          if (node.arguments[0].type === 'Literal' && typeof node.arguments[0].value === 'string') {
            const module = node.arguments[0].value;
            const dangerousModules = [
              'child_process',
              'fs',
              'net',
              'dgram',
              'tls',
              'crypto',
              'cluster',
              'worker_threads',
              'perf_hooks',
              'inspector',
              'v8',
              'vm',
              'os',
              'path',
              'url',
              'querystring',
            ];
            if (dangerousModules.includes(module)) {
              throw new Error(`Dangerous module import detected: ${module}`);
            }
          }
        }
      },
      ImportDeclaration(node: any) {
        const source = node.source.value;
        const dangerousModules = [
          'child_process',
          'fs',
          'net',
          'dgram',
          'tls',
          'crypto',
          'cluster',
          'worker_threads',
          'perf_hooks',
          'inspector',
          'v8',
          'vm',
          'os',
          'path',
          'url',
          'querystring',
        ];
        if (dangerousModules.includes(source)) {
          throw new Error(`Dangerous module import detected: ${source}`);
        }
      },
      FunctionDeclaration(_node: any) {
        // Check for nested function declarations that could be used to bypass security
      },
      ArrowFunctionExpression(_node: any) {
        // Check for arrow functions that could be used to bypass security
      },
    });

    return { passed: true };
  } catch (err: any) {
    return { passed: false, reason: err.message };
  }
}

// AST-based security scanner class for more advanced use cases
export class SecurityScanner extends EventEmitter {
  private blockedKeywords: string[];
  private blockedPatterns: RegExp[];
  private dangerousModules: string[];
  private dangerousFunctions: string[];

  constructor(
    options: {
      blockedKeywords?: string[];
      blockedPatterns?: RegExp[];
      dangerousModules?: string[];
      dangerousFunctions?: string[];
    } = {},
  ) {
    super();
    this.blockedKeywords = options.blockedKeywords || [
      'process.exit',
      'process.env',
      'fs.rmSync',
      'fs.unlinkSync',
      'child_process',
      'require(',
      'eval(',
      'Function(',
      'globalThis',
    ];
    this.blockedPatterns = options.blockedPatterns || [
      /while\s*\(\s*(?:1|true)\s*\)/,
      /for\s*\([^;]*;\s*;[^)]*\)/,
      /do\s*\{[\s\S]*?\}\s*while\s*\(\s*(?:1|true)\s*\)/,
    ];
    this.dangerousModules = options.dangerousModules || [
      'child_process',
      'fs',
      'net',
      'dgram',
      'tls',
      'crypto',
      'cluster',
      'worker_threads',
      'vm',
      'os',
      'inspector',
    ];
    this.dangerousFunctions = options.dangerousFunctions || [
      'eval',
      'Function',
      'setTimeout',
      'setInterval',
      'setImmediate',
      'process.exit',
      'process.kill',
      'vm.runInContext',
      'vm.runInNewContext',
    ];
  }

  public scan(code: string): { passed: boolean; violations: string[] } {
    const violations: string[] = [];

    // Check blocked keywords
    for (const keyword of this.blockedKeywords) {
      if (code.includes(keyword)) {
        violations.push(`Blocked keyword: ${keyword}`);
      }
    }

    // Check blocked patterns
    for (const pattern of this.blockedPatterns) {
      if (pattern.test(code)) {
        violations.push(`Blocked pattern: ${pattern.source}`);
      }
    }

    // AST-based analysis
    try {
      const ast = acorn.parse(code, {
        ecmaVersion: 'latest',
        sourceType: 'module',
        allowReturnOutsideFunction: true,
        allowAwaitOutsideFunction: true,
      });

      walk.simple(ast, {
        CallExpression: (_node: any) => {
          if (_node.callee.type === 'Identifier') {
            if (this.dangerousFunctions.includes(_node.callee.name)) {
              violations.push(`Dangerous function call: ${_node.callee.name}`);
            }
          }
          if (_node.callee.name === 'require' && _node.arguments.length > 0) {
            if (
              _node.arguments[0].type === 'Literal' &&
              typeof _node.arguments[0].value === 'string'
            ) {
              const module = _node.arguments[0].value;
              if (this.dangerousModules.includes(module)) {
                violations.push(`Dangerous module import: ${module}`);
              }
            }
          }
        },
        ImportDeclaration: (_node: any) => {
          if (this.dangerousModules.includes(_node.source.value)) {
            violations.push(`Dangerous module import: ${_node.source.value}`);
          }
        },
        FunctionDeclaration: (_node: any) => {
          // Could add more checks here
        },
        ArrowFunctionExpression: (_node: any) => {
          // Could add more checks here
        },
      });
    } catch (err) {
      violations.push(`AST parsing error: ${err instanceof Error ? err.message : String(err)}`);
    }

    return {
      passed: violations.length === 0,
      violations,
    };
  }

  public addBlockedKeyword(keyword: string): void {
    this.blockedKeywords.push(keyword);
  }

  public addBlockedPattern(pattern: RegExp): void {
    this.blockedPatterns.push(pattern);
  }

  public addDangerousModule(module: string): void {
    this.dangerousModules.push(module);
  }

  public addDangerousFunction(fn: string): void {
    this.dangerousFunctions.push(fn);
  }
}

export function validateIsolatedVmCompatibility(code: string): { passed: boolean; reason?: string } {
  const dangerous = [
    'constructor.constructor',
    'process.',
    'require(',
    'eval(',
    'Function(',
    'vm.runInContext',
    'vm.runInNewContext',
    'vm.createContext',
  ];
  for (const pattern of dangerous) {
    if (code.includes(pattern)) {
      return { passed: false, reason: `isolated-vm incompatible pattern: ${pattern}` };
    }
  }
  return { passed: true };
}

export const securityScanner = new SecurityScanner();
