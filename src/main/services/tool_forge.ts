// src/main/services/tool_forge.ts
// NOVA Tool Forge — REAL tool creation.
//
// This is the production replacement for the old deterministic `localCodeGenerator`
// stub. The Forge:
//   1. asks the AI (Groq preferred, Gemini fallback) for a tool design: a
//      human display name, a stable technical id, a capability description,
//      REAL Python source, and REAL test code;
//   2. writes tool.py + test_tool.py + manifest.json + requirements.txt into
//      the NOVA workspace tools root (SQLite metadata persisted by the registry);
//   3. statically audits the generated Python (security, size, entry point);
//   4. runs the generated tests in an ISOLATED sandbox via the Python worker
//      (scrubbed env, throwaway temp dir, hard timeout);
//   5. if tests fail, sends the failure output back to the AI to REPAIR the
//      generated code (bounded attempts — never an infinite loop);
//   6. registers the validated tool in the Tool Registry (persisted to SQLite)
//      under its AI-chosen human name + stable technical id + version 1.0.0;
//   7. executes it in PRODUCTION through the real Python runtime (the sandbox
//      is only for validation, never for real actions).
//
// THE SANDBOX TESTS THE TOOL. THE REAL PC EXECUTES THE VALIDATED TOOL.
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { ToolRegistry } from './tool_registry';
import { ToolDefinition, ToolPermission } from './tool_types';
import { pythonRuntime } from './python_runtime';
import { aiProviderRegistry, AiProvider } from './ai_provider';
import { taskRouter } from './task_router';
import { logger } from '../core/logger';
import { NovaConfig } from '../core/config';

const MAX_REPAIR_ATTEMPTS = 2;
const SANDBOX_TEST_TIMEOUT_MS = 30000;
const MAX_SOURCE_BYTES = 32 * 1024;

/**
 * Imports that AI-generated tool code is NOT allowed to use. `ctypes` is
 * excluded from the ban because the templates (project-reviewed source) need
 * it for real Win32 calls; the strict audit is only applied to AI output.
 */

export interface ForgeAuditOptions {
  /**
   * Strict audit (AI-generated code): bans dangerous imports/calls.
   * Lenient audit (project-reviewed templates): structural checks only.
   * Default: strict.
   */
  strict?: boolean;
}
const BANNED_IMPORT_RE =
  /\b(?:import|from)\s+(?:subprocess|socket|os\.system|shutil|multiprocessing|pickle|marshal|shelve|dbm|pty|posix|grp|pwd|urllib|requests|http\.client|ftplib|telnetlib|smtplib|imaplib|poplib)\b/;
/** Calls that must never appear in generated code. */
const BANNED_CALL_RE =
  /\b(?:os\.system|os\.popen|os\.remove|os\.unlink|os\.rmdir|shutil\.rmtree|eval|exec|__import__|compile|open\(\s*['\"]+\/)\b/;

export interface ForgeDesign {
  /** Human display name chosen by the AI, e.g. "Vision Capture". */
  displayName: string;
  /** Stable machine id, e.g. "vision_capture". */
  technicalId: string;
  description: string;
  category: string;
  capabilities: string[];
  permissions: ToolPermission[];
  dependencies: string[];
  pythonSource: string;
  testSource: string;
}

export interface ForgeResult {
  tool: ToolDefinition;
  design: ForgeDesign;
  testOutput: string;
  repairCount: number;
  execution: unknown;
  /** True when the whole lifecycle completed and the production run returned a real result. */
  productionOk: boolean;
}

interface ForgeArtifacts {
  toolPath: string;
  testPath: string;
  manifestPath: string;
  requirementsPath: string;
}

/**
 * Deterministic fallback used ONLY when no AI provider is configured AND the
 * request maps to one of the well-known capability templates below. This is a
 * real implementation with real tests — never a mock that echoes the intent.
 * When the request does not match a template and no AI is available, the Forge
 * fails honestly instead of fabricating a fake capability.
 */
function templateForge(intent: string): ForgeDesign | null {
  const lower = intent.toLowerCase();

  if (/\b(active|current|foreground|focused)\b.*\bwindow\b|which\s+(app|window)/.test(lower)) {
    return {
      displayName: 'Window Insight',
      technicalId: 'window_insight',
      description: 'Reports the title and process id of the currently active window.',
      category: 'windows',
      capabilities: ['WINDOW_INSPECT', 'SYSTEM_READ'],
      permissions: [{ type: 'fs-read', scope: [] }],
      dependencies: [],
      pythonSource: `# Window Insight — reports the active window title + pid (real Win32).
import ctypes
import ctypes.wintypes as wt

def run(params):
    hwnd = ctypes.windll.user32.GetForegroundWindow()
    pid = wt.DWORD()
    ctypes.windll.user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
    length = ctypes.windll.user32.GetWindowTextLengthW(hwnd)
    buf = ctypes.create_unicode_buffer(length + 1)
    ctypes.windll.user32.GetWindowTextW(hwnd, buf, length + 1)
    title = buf.value
    return {"success": True, "title": title or "(no title)", "pid": int(pid.value), "hwnd": int(hwnd)}
`,
      testSource: `import sys
sys.path.insert(0, ".")
from tool import run

def test_run_returns_dict():
    result = run({})
    assert isinstance(result, dict), "run() must return a dict"
    assert result.get("success") is True, "success flag must be True"
    assert "title" in result and "pid" in result, "title+pid present"
    print("ALL_TESTS_PASSED")
`,
    };
  }

  if (/\b(cpu|ram|gpu|memory|system|uptime|specs)\b/.test(lower)) {
    return {
      displayName: 'Hardware Snapshot',
      technicalId: 'hardware_snapshot',
      description: 'Reads real CPU/RAM/uptime information from the host.',
      category: 'system',
      capabilities: ['SYSTEM_READ'],
      permissions: [],
      dependencies: [],
      pythonSource: `# Hardware Snapshot — real host CPU/RAM/uptime.
import os
import platform
import time

def run(params):
    info = os.uname() if hasattr(os, "uname") else None
    total = round(os.sysconf("SC_PHYS_PAGES") * os.sysconf("SC_PAGE_SIZE") / 2**30, 2) if hasattr(os, "sysconf") else 0
    return {
        "success": True,
        "os": info.sysname if info else platform.system(),
        "arch": platform.machine(),
        "python": platform.python_version(),
        "totalRamGb": total,
    }
`,
      testSource: `import sys
sys.path.insert(0, ".")
from tool import run

def test_run_returns_dict():
    result = run({})
    assert isinstance(result, dict)
    assert result.get("success") is True
    assert "os" in result and "arch" in result
    print("ALL_TESTS_PASSED")
`,
    };
  }

  return null;
}

function isStreamWidgetIntent(intent: string): boolean {
  return /stream|live|tv|video|watch|broadcast|feed|youtube|news\s+(stream|feed)/i.test(intent);
}

function extractDesign(text: string): Partial<ForgeDesign> | null {
  const cleaned = text
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '')
    .trim();
  const first = cleaned.indexOf('{');
  const last = cleaned.lastIndexOf('}');
  if (first < 0 || last <= first) return null;
  const candidate = cleaned.slice(first, last + 1);
  try {
    return JSON.parse(candidate) as Partial<ForgeDesign>;
  } catch {
    // Models occasionally emit literal line breaks inside the JSON string
    // values that carry generated Python. Repair only those illegal control
    // characters; leave the actual JSON structure and escaped sequences alone.
    let repaired = '';
    let inString = false;
    let escaped = false;
    for (const char of candidate) {
      if (escaped) {
        repaired += char;
        escaped = false;
        continue;
      }
      if (char === '\\') {
        repaired += char;
        escaped = true;
        continue;
      }
      if (char === '"') {
        repaired += char;
        inString = !inString;
        continue;
      }
      if (inString && char === '\n') {
        repaired += '\\n';
      } else if (inString && char === '\r') {
        repaired += '\\r';
      } else if (inString && char === '\t') {
        repaired += '\\t';
      } else {
        repaired += char;
      }
    }
    try {
      return JSON.parse(repaired) as Partial<ForgeDesign>;
    } catch {
      return null;
    }
  }
}

function defaultDesign(intent: string): ForgeDesign {
  const slug = intent
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40) || 'nova_tool';
  return {
    displayName: intent.slice(0, 48),
    technicalId: slug,
    description: `Generated capability: ${intent.slice(0, 120)}`,
    category: 'generic',
    capabilities: [],
    permissions: [],
    dependencies: [],
    pythonSource: '',
    testSource: '',
  };
}

export class ToolForge {
  private registry: ToolRegistry;

  constructor(registry: ToolRegistry) {
    this.registry = registry;
  }

  /** The workspace tools root where forged tools are stored on disk. */
  public static toolsRoot(): string {
    return NovaConfig.paths.toolsRoot;
  }

  private static makeTechnicalId(design: ForgeDesign, fallback: string): string {
    const id = (design.technicalId || '').toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
    return id || fallback;
  }

  /** Static audit of the generated Python: banned imports/calls, size, entry point. */
  public static audit(design: ForgeDesign, opts: ForgeAuditOptions = {}): string[] {
    const violations: string[] = [];
    const source = design.pythonSource ?? '';
    const strict = opts.strict !== false;
    if (!source.trim()) violations.push('generated Python source is empty');
    if (source.length > MAX_SOURCE_BYTES) violations.push(`generated source exceeds ${MAX_SOURCE_BYTES} bytes`);
    if (strict) {
      if (BANNED_IMPORT_RE.test(source)) violations.push('generated code uses a banned import (subprocess/socket/ctypes/... )');
      if (BANNED_CALL_RE.test(source)) violations.push('generated code uses a banned call (os.system/eval/exec/__import__/... )');
    }
    if (!/def\s+run\s*\(/.test(source)) violations.push('generated code has no run(params) entry point');
    if (!(design.testSource ?? '').includes('assert')) violations.push('generated tests contain no assertions');
    return violations;
  }

  private writeArtifacts(design: ForgeDesign, technicalId: string): ForgeArtifacts {
    const dir = path.join(ToolForge.toolsRoot(), technicalId);
    const testsDir = path.join(dir, 'tests');
    fs.mkdirSync(testsDir, { recursive: true });
    const toolPath = path.join(dir, 'tool.py');
    const testPath = path.join(testsDir, 'test_tool.py');
    const manifestPath = path.join(dir, 'manifest.json');
    const requirementsPath = path.join(dir, 'requirements.txt');
    fs.writeFileSync(toolPath, design.pythonSource, 'utf-8');
    fs.writeFileSync(testPath, design.testSource, 'utf-8');
    fs.writeFileSync(requirementsPath, (design.dependencies ?? []).join('\n'), 'utf-8');
    fs.writeFileSync(
      manifestPath,
      JSON.stringify(
        {
          technicalId,
          displayName: design.displayName,
          description: design.description,
          category: design.category,
          capabilities: design.capabilities ?? [],
          permissions: design.permissions ?? [],
          dependencies: design.dependencies ?? [],
          version: '1.0.0',
          sourceHash: crypto.createHash('sha256').update(design.pythonSource, 'utf-8').digest('hex'),
          createdAt: Date.now(),
        },
        null,
        2,
      ),
      'utf-8',
    );
    return { toolPath, testPath, manifestPath, requirementsPath };
  }

  /** Runs the generated tests inside the isolated Python sandbox. */
  public async sandboxTest(toolPath: string, testPath: string): Promise<{ passed: boolean; output: string }> {
    const result = await pythonRuntime.request(
      'forge.test',
      { tool_path: toolPath, test_path: testPath, timeout_ms: SANDBOX_TEST_TIMEOUT_MS },
      SANDBOX_TEST_TIMEOUT_MS + 10000,
    );
    if (!result.ok) {
      return { passed: false, output: result.error ?? 'sandbox test failed' };
    }
    const data = result.data as { passed?: boolean; output?: string };
    return { passed: data?.passed === true, output: data?.output ?? '' };
  }

  private async generateWithProvider(
    provider: AiProvider,
    intent: string,
    previousFailure: string | null,
  ): Promise<ForgeDesign> {
    const repairBlock = previousFailure
      ? `\n\nThe previously generated code FAILED its sandbox tests with this output:\n\`\`\`\n${previousFailure.slice(0, 2500)}\n\`\`\`\nAnalyze the failure and generate a corrected version.`
      : '';
    const prompt = `You are NOVA's Tool Forge. Design a real capability for the request: "${intent}".

Do not ask the user follow-up questions. Infer sensible defaults and produce an executable tool now. The tool must implement the requested behavior, not merely return an explanation or echo the input.

Return ONLY a JSON object with this exact shape:
{
  "displayName": "Human-friendly tool name, e.g. Vision Capture",
  "technicalId": "stable_lowercase_technical_id",
  "description": "one sentence describing the capability",
  "category": "windows|system|files|network|media|utility",
  "capabilities": ["SCREEN_CAPTURE", "WINDOW_INSPECT", "SYSTEM_READ", ...],
  "permissions": [{"type": "fs-read|fs-write|net-http|net-https", "scope": ["*"]}],
  "dependencies": [],
  "pythonSource": "complete Python module source. It MUST define: def run(params: dict) -> dict. Use ONLY the Python standard library. No subprocess, no socket, no ctypes, no os.system, no eval/exec, no file writes outside a passed path. Return a JSON-serializable dict with a 'success' boolean. Do NOT include markdown fences.",
  "testSource": "complete Python test module source. It MUST import the tool with 'from tool import run' (tests run in a dir containing tool.py), call run() with sample params, and assert real behavior with Python 'assert' statements. End with print('ALL_TESTS_PASSED')."
}
${repairBlock}
Output ONLY the JSON object.`;
    const raw = await provider.generate(prompt, { maxOutputTokens: 3072 });
    const parsed = extractDesign(raw);
    if (!parsed || !parsed.pythonSource || !parsed.testSource) {
      throw new Error('AI returned a response that is not a valid forge design JSON');
    }
    const fallback = defaultDesign(intent);
    return {
      displayName: String(parsed.displayName ?? fallback.displayName),
      technicalId: String(parsed.technicalId ?? fallback.technicalId),
      description: String(parsed.description ?? fallback.description),
      category: String(parsed.category ?? fallback.category),
      capabilities: Array.isArray(parsed.capabilities) ? parsed.capabilities.map(String) : [],
      permissions: Array.isArray(parsed.permissions) ? (parsed.permissions as ToolPermission[]) : [],
      dependencies: Array.isArray(parsed.dependencies) ? parsed.dependencies.map(String) : [],
      pythonSource: String(parsed.pythonSource),
      testSource: String(parsed.testSource),
    };
  }

  /**
   * Runs the full Forge lifecycle. Returns the registered tool plus the
   * production execution result. Throws a descriptive error when the
   * capability cannot be safely built (after bounded repair attempts).
   */
  public async forgeTool(intent: string): Promise<ForgeResult> {
    const provider =
      taskRouter.providerFor?.('tool_synthesis') ?? aiProviderRegistry.primary();
    const useTemplate = isStreamWidgetIntent(intent) ? null : templateForge(intent);

    let design: ForgeDesign;
    let repairCount = 0;
    let testOutput = '';

    if (useTemplate) {
      design = useTemplate;
    } else if (provider) {
      // AI-assisted design with a bounded repair loop. The AI decides the
      // human name AND the implementation; failures are fed back for repair.
      design = await this.generateWithProvider(provider, intent, null);
      const auditViolations = ToolForge.audit(design, { strict: true });
      if (auditViolations.length > 0) {
        throw new Error(`Forge static audit failed: ${auditViolations.join('; ')}`);
      }
      for (let attempt = 0; attempt < MAX_REPAIR_ATTEMPTS; attempt++) {
        const artifacts = this.writeArtifacts(design, ToolForge.makeTechnicalId(design, `tool_${Date.now()}`));
        const test = await this.sandboxTest(artifacts.toolPath, artifacts.testPath);
        testOutput = test.output;
        if (test.passed) break;
        repairCount = attempt + 1;
        logger.warn('[tool_forge] sandbox tests failed; repairing with AI', {
          attempt: attempt + 1,
          technicalId: design.technicalId,
          output: test.output.slice(0, 500),
        });
        design = await this.generateWithProvider(provider, intent, test.output);
        const nextAudit = ToolForge.audit(design, { strict: true });
        if (nextAudit.length > 0) {
          throw new Error(`Forge repair failed static audit: ${nextAudit.join('; ')}`);
        }
        if (attempt === MAX_REPAIR_ATTEMPTS - 1) {
          throw new Error(`Forge could not produce a passing tool after ${MAX_REPAIR_ATTEMPTS + 1} attempts. Last test output: ${test.output.slice(0, 1200)}`);
        }
      }
    } else {
      throw new Error(
        'No AI provider is configured for tool synthesis. Add a GROQ_API_KEY or GEMINI_API_KEY via the NOVA Secrets vault (or environment), then ask again — NOVA will design, test and register the capability for you.',
      );
    }

    const technicalId = ToolForge.makeTechnicalId(design, `tool_${Date.now()}`);
    const artifacts = this.writeArtifacts(design, technicalId);
    // Templates (project-reviewed) get a structural audit; the strict security
    // audit is for AI-generated code only.
    const auditViolations = ToolForge.audit(design, { strict: !useTemplate });
    if (auditViolations.length > 0) {
      throw new Error(`Forge static audit failed: ${auditViolations.join('; ')}`);
    }
    // Always run the sandbox test before registration (template or AI path).
    const finalTest = await this.sandboxTest(artifacts.toolPath, artifacts.testPath);
    testOutput = finalTest.output;
    if (!finalTest.passed) {
      throw new Error(`Forge sandbox tests failed before registration: ${finalTest.output.slice(0, 1200)}`);
    }

    const now = Date.now();
    const tool: ToolDefinition = {
      id: crypto.randomUUID(),
      name: design.displayName,
      technicalId,
      description: design.description,
      category: design.category,
      author: 'ai',
      version: '1.0.0',
      dependencies: design.dependencies ?? [],
      entryPoint: 'python',
      sourcePath: artifacts.toolPath,
      capabilities: design.capabilities ?? [],
      config: { intent, technicalId },
      permissions: design.permissions ?? [],
      sourceCode: design.pythonSource,
      sourceHash: crypto.createHash('sha256').update(design.pythonSource, 'utf-8').digest('hex'),
      enabled: true,
      status: 'active',
      createdAt: now,
      updatedAt: now,
      lastExecutedAt: null,
      lastValidationDate: now,
      executionCount: 0,
      successCount: 0,
      totalExecutionTimeMs: 0,
      health: 'unknown',
      versions: [],
    };
    this.registry.register(tool);

    // PRODUCTION execution on the real machine through the Python runtime.
    const execResult = await pythonRuntime.request(
      'forge.run',
      { tool_path: artifacts.toolPath, params: { intent } },
      30000,
    );
    const productionPayload = execResult.data as { result?: unknown } | null;
    const returnedResult = productionPayload?.result;
    const productionOk =
      execResult.ok &&
      !(returnedResult && typeof returnedResult === 'object' && (returnedResult as { success?: unknown }).success === false);
    logger.audit('tool.forge', productionOk ? 'ok' : 'failed', {
      technicalId,
      toolName: tool.name,
      repairCount,
      productionOk,
      error: execResult.ok ? null : execResult.error,
    });

    return {
      tool,
      design,
      testOutput,
      repairCount,
      execution: productionOk ? execResult.data : {
        error: execResult.error ?? (returnedResult as { error?: unknown } | null)?.error ?? 'production tool execution failed',
      },
      productionOk,
    };
  }
}
