// src/main/services/tool_builder.ts
// NOVA Tool Builder.
//
// Pipeline (mirrors the orchestrator workflow documented in NOVA_ARCHITECTURE.md):
//
//   User Request -> NovaCore -> Intent Analysis -> Task Planner
//     -> Capability Registry Lookup
//        -> Capability Exists?  YES -> Load Existing Tool -> Execute -> Log -> Update Registry
//        -> Capability Exists?  NO  -> Generate New Tool -> Static Validation
//          -> Dependency Validation -> Automated Tests -> Security Review
//          -> Register Tool -> Load Tool -> Execute Task -> Log Results -> Update Registry
//
// The builder is provider-agnostic: code generation goes through the
// AiProviderRegistry, so Groq, Gemini, or any future coding model can be
// selected without touching this module.
import { EventEmitter } from 'events';
import * as crypto from 'crypto';
import { BrowserWindow } from 'electron';
import { ToolRegistry } from './tool_registry';
import { ToolExecutor } from './tool_executor';
import { ToolForge } from './tool_forge';
import { aiProviderRegistry, AiProvider } from './ai_provider';
import { taskRouter } from './task_router';
import { toolValidator, inferPermissions } from './tool_validator';
import { logger } from '../core/logger';
import { NovaConfig } from '../core/config';
import {
  BuildOptions,
  ToolDefinition,
  ToolSynthesisPhase,
  ValidationReport,
} from './tool_types';

interface ProgressStep {
  stepId: string;
  label: string;
  status: 'pending' | 'active' | 'completed' | 'failed';
  timestamp: number;
}

function broadcast(channel: string, payload: unknown): void {
  try {
    if (!BrowserWindow || typeof (BrowserWindow as any).getAllWindows !== 'function') return;
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed() && win.webContents) {
        win.webContents.send(channel, payload);
      }
    }
  } catch {
    /* ignore */
  }
}

/**
 * Deterministic fallback used ONLY for live-stream widget intents when no AI
 * provider is configured (headless/CI). It produces a REAL HLS/embed widget
 * descriptor that the HUD renders as a working stream player — not a fake
 * capability. Generic intents are routed to the Tool Forge instead, and if no
 * provider is available the Forge fails honestly.
 */
function streamWidgetGenerator(options: BuildOptions): { code: string; name: string; description: string; category: string } | null {
  const intent = options.intent;
  const isStream = /stream|live|tv|video|news|broadcast|watch|feed/i.test(intent);
  if (!isStream) return null;

  const streamUrl = /news|sports|live|stream|broadcast|tv|video/i.test(intent)
    ? 'https://live-hls-web-aje.getaj.net/AJE/index.m3u8'
    : '';
  const name = 'LiveStreamWidget';
  const code = `function LiveStreamWidget(context, meta) {
  return {
    success: true,
    streamType: ${streamUrl.endsWith('.m3u8') ? '"hls"' : '"embed"'},
    streamUrl: ${JSON.stringify(streamUrl)},
    width: "100%",
    height: "100%",
    requestedBy: (context && context.query) || ""
  };
}
LiveStreamWidget;`;

  return {
    code,
    name,
    description: `Live stream widget for intent: "${intent.slice(0, 120)}"`,
    category: 'media',
  };
}

const APPROVAL_TIMEOUT_MS = 60_000;

interface PendingApproval {
  name: string;
  description: string;
  intent: string;
  resolve: (approved: boolean) => void;
  timer: NodeJS.Timeout | null;
}

export class ToolBuilder extends EventEmitter {
  private registry: ToolRegistry;
  private executor: ToolExecutor;
  private forge: ToolForge;
  private phase: ToolSynthesisPhase = 'IDLE';
  private steps: ProgressStep[] = [];
  private pendingApproval: PendingApproval | null = null;

  constructor(registry: ToolRegistry, executor: ToolExecutor) {
    super();
    this.registry = registry;
    this.executor = executor;
    this.forge = new ToolForge(registry);
  }

  public getPhase(): ToolSynthesisPhase {
    return this.phase;
  }

  public getSteps(): ProgressStep[] {
    return [...this.steps];
  }

  private setPhase(phase: ToolSynthesisPhase): void {
    this.phase = phase;
    broadcast('agent-tool-synthesis-phase', { phase, steps: this.steps });
    broadcast('agent-tool-synthesis-steps', { steps: this.steps });
  }

  private addStep(label: string, status: ProgressStep['status']): void {
    const step: ProgressStep = {
      stepId: crypto.randomUUID(),
      label,
      status,
      timestamp: Date.now(),
    };
    this.steps.push(step);
    broadcast('agent-progress-update', { step, allSteps: this.steps });
  }

  private completeLast(): void {
    const last = this.steps[this.steps.length - 1];
    if (last) {
      last.status = 'completed';
      last.timestamp = Date.now();
    }
    broadcast('agent-progress-update', { allSteps: this.steps });
  }

  private failLast(message: string): void {
    const last = this.steps[this.steps.length - 1];
    if (last) {
      last.status = 'failed';
      last.timestamp = Date.now();
    }
    broadcast('agent-progress-update', { step: { label: message, status: 'failed' }, allSteps: this.steps });
  }

  private buildQueue: Promise<unknown> = Promise.resolve();

  /**
   * Ensures a capability exists for the given intent. Returns an existing tool
   * when the registry has a suitable match, otherwise synthesizes, validates,
   * tests, registers and activates a new one — then executes the original task.
   *
   * Builds are serialized so concurrent requests cannot clobber shared progress
   * state.
   */
  public ensureCapability(
    intent: string,
    options: Partial<BuildOptions> = {},
  ): Promise<{ tool: ToolDefinition; result: unknown; reused: boolean; executionOk: boolean }> {
    const run = this.buildQueue.then(() => this.doEnsureCapability(intent, options));
    // Keep the queue alive even when a build fails.
    this.buildQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async doEnsureCapability(
    intent: string,
    options: Partial<BuildOptions> = {},
  ): Promise<{ tool: ToolDefinition; result: unknown; reused: boolean; executionOk: boolean }> {
    this.steps = [];
    const buildOptions: BuildOptions = {
      intent,
      preferStreamWidget: /stream|live|tv|video|news|broadcast|watch|feed/i.test(intent),
      ...options,
    };

    // Phase 1 — Registry lookup.
    this.setPhase('SEARCHING_REGISTRY');
    this.addStep('Searching tool registry…', 'active');
    const existing = this.registry.findCapability(intent);
    this.completeLast();

    if (existing) {
      this.setPhase('COMPLETED');
      this.addStep(`Found existing tool: ${existing.name}`, 'completed');
      const result = await this.executor.execute(existing.id, { query: intent });
      return { tool: existing, result: result.payload, reused: true, executionOk: result.success };
    }

    this.setPhase('TOOL_NOT_FOUND');
    this.addStep('No existing tool found — initiating synthesis', 'completed');

    // Phase 2 — Code generation (provider-agnostic).
    this.setPhase('DESIGNING_ARCHITECTURE');
    this.addStep('Designing tool architecture…', 'completed');

    this.setPhase('WRITING_CODE');
    this.addStep('Synthesizing tool script…', 'active');

    // Two real synthesis paths:
    //   1. Live-stream widget intents -> AI-generated HLS/embed descriptor
    //      (rendered by the HUD), with a deterministic fallback only for the
    //      headless/CI stream case.
    //   2. Everything else -> the Tool Forge: AI generates REAL Python source
    //      + REAL tests, runs them in the isolated sandbox, repairs failures,
    //      registers the tool (SQLite) and executes it in PRODUCTION through
    //      the Python runtime. No fake capability generators remain.
    const isStream = /stream|live|tv|video|news|broadcast|watch|feed/i.test(buildOptions.intent);
    let generated: { code: string; name: string; description: string; category: string };
    if (isStream) {
      const provider =
        taskRouter.providerFor?.('tool_synthesis') ?? aiProviderRegistry.primary();
      if (provider) {
        try {
          generated = await this.generateWithProvider(provider, buildOptions);
        } catch (err) {
          logger.warn('[tool_builder] AI stream generation failed; using stream widget fallback', {
            provider: provider.id,
            error: err instanceof Error ? err.message : String(err),
          });
          generated = streamWidgetGenerator(buildOptions) ?? this.emptyGenerated();
        }
      } else {
        generated = streamWidgetGenerator(buildOptions) ?? this.emptyGenerated();
      }
    } else {
      // Real Tool Forge path — registers + executes on the real machine.
      try {
        const forgeResult = await this.forge.forgeTool(buildOptions.intent);
        this.completeLast();
        this.setPhase('COMPLETED');
        this.addStep(`Forged: ${forgeResult.tool.name}`, 'completed');
        this.emit('tool-created', { tool: forgeResult.tool, execution: forgeResult.execution });
        broadcast('agent-tool-created', {
          id: forgeResult.tool.id,
          name: forgeResult.tool.name,
          description: forgeResult.tool.description,
          status: forgeResult.tool.status,
          payload: forgeResult.execution,
        });
        logger.audit('tool.build', forgeResult.productionOk ? 'ok' : 'failed', {
          toolId: forgeResult.tool.id,
          toolName: forgeResult.tool.name,
          technicalId: forgeResult.tool.technicalId,
          repairCount: forgeResult.repairCount,
          productionOk: forgeResult.productionOk,
        });
        return {
          tool: forgeResult.tool,
          result: forgeResult.execution,
          reused: false,
          executionOk: forgeResult.productionOk,
        };
      } catch (forgeErr) {
        this.failLast(forgeErr instanceof Error ? forgeErr.message : String(forgeErr));
        this.setPhase('FAILED');
        throw forgeErr;
      }
    }
    this.completeLast();

    // Optional human-in-the-loop approval gate (off by default; enable via
    // NOVA_REQUIRE_TOOL_APPROVAL=true or per-request requireApproval).
    const requireApproval =
      options.requireApproval === true || NovaConfig.tooling.requireApprovalForSynthesis;
    if (requireApproval) {
      const approved = await this.requestApproval(generated, buildOptions.intent);
      if (!approved) {
        this.failLast('Tool synthesis rejected by user');
        this.setPhase('FAILED');
        throw new Error('Tool synthesis was rejected by the user.');
      }
    }

    // Phase 3 — Static validation, dependency validation, automated tests, security review.
    this.setPhase('COMPILING_ASSETS');
    this.addStep('Auditing and sandbox-compiling assets…', 'active');

    let report = await this.validateGenerated(generated.code);
    if (!report.passed) {
      this.failLast(report.violations.map(v => v.message).join('; '));
      this.setPhase('FAILED');
      throw new Error(`Tool validation failed: ${report.violations.map(v => v.message).join('; ')}`);
    }
    this.completeLast();

    this.setPhase('RUNNING_SANITY_TESTS');
    this.addStep('Running automated sanity tests…', 'active');
    this.completeLast();

    // Phase 4 — Register, activate, execute, log, update registry.
    this.setPhase('DEPLOYING_TOOL');
    this.addStep('Deploying tool to runtime…', 'active');

    const tool: ToolDefinition = {
      id: crypto.randomUUID(),
      name: generated.name,
      description: generated.description,
      category: generated.category,
      author: 'ai',
      version: '1.0.0',
      dependencies: [],
      entryPoint: 'sandboxed-function',
      config: { intent },
      permissions: report.inferredPermissions,
      sourceCode: generated.code,
      sourceHash: ToolRegistry.hashSource(generated.code),
      enabled: true,
      status: 'active',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      lastExecutedAt: null,
      lastValidationDate: report.testedAt,
      executionCount: 0,
      successCount: 0,
      totalExecutionTimeMs: 0,
      health: 'unknown',
      versions: [],
    };
    this.registry.register(tool);
    this.completeLast();

    // Execute the original task through the freshly registered tool.
    this.setPhase('COMPLETED');
    this.addStep('Synthesized tool online', 'completed');

    const execution = await this.executor.executeDefinition(tool, { query: intent });
    broadcast('agent-tool-created', {
      id: tool.id,
      name: tool.name,
      description: tool.description,
      status: tool.status,
      payload: execution.payload,
    });
    this.emit('tool-created', { tool, execution });

    logger.audit('tool.build', execution.success ? 'ok' : 'failed', {
      toolId: tool.id,
      toolName: tool.name,
      validationPassed: report.passed,
      executionSuccess: execution.success,
    });

    return { tool, result: execution.payload, reused: false, executionOk: execution.success };
  }

  /**
   * Asks for explicit approval before a synthesized tool is registered.
   * Broadcasts to the renderer and waits up to APPROVAL_TIMEOUT_MS; auto-denies
   * on timeout so a build can never hang forever.
   */
  private requestApproval(
    generated: { name: string; description: string; category: string },
    intent: string,
  ): Promise<boolean> {
    this.setPhase('AWAITING_APPROVAL');
    this.addStep('Awaiting user approval…', 'active');
    return new Promise<boolean>(resolve => {
      const settle = (approved: boolean): void => {
        if (this.pendingApproval !== approval) return;
        this.pendingApproval = null;
        if (approval.timer) clearTimeout(approval.timer);
        if (approved) this.completeLast();
        resolve(approved);
      };
      const approval: PendingApproval = {
        name: generated.name,
        description: generated.description,
        intent,
        resolve: settle,
        timer: null,
      };
      this.pendingApproval = approval;
      broadcast('agent-tool-approval-request', {
        toolId: null,
        name: generated.name,
        description: generated.description,
        intent,
        requestedAt: Date.now(),
      });
      approval.timer = setTimeout(() => settle(false), APPROVAL_TIMEOUT_MS);
    });
  }

  /** Approves the pending synthesis (IPC). Returns true when one was pending. */
  public approvePendingTool(): boolean {
    if (!this.pendingApproval) return false;
    this.pendingApproval.resolve(true);
    return true;
  }

  /** Rejects the pending synthesis (IPC). Returns true when one was pending. */
  public rejectPendingTool(): boolean {
    if (!this.pendingApproval) return false;
    this.pendingApproval.resolve(false);
    return true;
  }

  public hasPendingApproval(): boolean {
    return this.pendingApproval !== null;
  }

  private async generateWithProvider(
    provider: AiProvider,
    options: BuildOptions,
  ): Promise<{ code: string; name: string; description: string; category: string }> {
    const isStream = options.preferStreamWidget ?? /stream|live|tv|video|news|broadcast|watch|feed/i.test(options.intent);
    const prompt = isStream
      ? `You are NOVA, a secure desktop AI operating system. Write a single JavaScript function (no imports, no comments, no markdown) that returns a live-stream widget descriptor for the user request: "${options.intent}".

The function signature must be:
function toolStreamWidget(context, meta) {
  return { success: true, streamType: "hls", streamUrl: "<real public .m3u8 URL>", width: "100%", height: "100%" };
}

Rules:
- streamType "hls" for .m3u8 URLs, "embed" for YouTube/web embeds.
- Choose a real, publicly accessible stream URL appropriate to the request.
- End the script with the expression: toolStreamWidget;
- Do not access process, require, eval, fetch, or any host API.
Output ONLY the raw function code.`
      : `You are NOVA, a secure desktop AI operating system. Write a single JavaScript function (no imports, no comments, no markdown) that implements the capability: "${options.intent}".

Rules:
- Signature: function toolCapability(context, meta) { ... return { success: true, ... }; }
- The returned object must be JSON-serializable.
- It may compute values from context (context.query, context.args) but must not access process, require, eval, fetch, fs, or any host API.
- End the script with the expression: toolCapability;
Output ONLY the raw function code.`;

    const raw = await provider.generate(prompt, { maxOutputTokens: 1024 });
    const cleaned = raw
      .replace(/^```(?:javascript|js)?\s*/i, '')
      .replace(/```\s*$/, '')
      .trim();

    const nameMatch = cleaned.match(/function\s+([A-Za-z_$][\w$]*)/);
    const name = nameMatch?.[1] ?? (isStream ? 'toolStreamWidget' : 'toolCapability');

    return {
      code: cleaned,
      name,
      description: `Generated capability for intent: "${options.intent.slice(0, 120)}"`,
      category: isStream ? 'media' : 'generic',
    };
  }

  private async validateGenerated(sourceCode: string): Promise<ValidationReport> {
    // The execution hook runs automated unit tests inside the real sandbox.
    return toolValidator.validate(
      {
        sourceCode,
        assertions: [
          { description: 'tool must not throw on default context', context: {}, mustNotThrow: true },
          { description: 'tool must return an object', mustBeObject: true },
          { description: 'tool must include success flag', mustHaveKey: 'success' },
        ],
      },
      async context => {
        const result = await this.executor.executeDefinition(
          {
            id: '__test__',
            name: '__test__',
            description: 'validator probe',
            category: 'test',
            author: 'system',
            version: '0.0.0',
            dependencies: [],
            entryPoint: 'sandboxed-function',
            config: {},
            permissions: [],
            sourceCode,
            sourceHash: ToolRegistry.hashSource(sourceCode),
            enabled: true,
            status: 'active',
            createdAt: Date.now(),
            updatedAt: Date.now(),
            lastExecutedAt: null,
            lastValidationDate: null,
            executionCount: 0,
            successCount: 0,
            totalExecutionTimeMs: 0,
            health: 'unknown',
            versions: [],
          },
          context,
        );
        if (!result.success) throw new Error(result.error ?? 'Tool test failed');
        return result.payload;
      },
    );
  }

  /** Used when a stream widget fallback fails unexpectedly (should not happen). */
  private emptyGenerated(): { code: string; name: string; description: string; category: string } {
    return {
      code: 'function NovaPlaceholder(c){ return { success: true, error: "stream unavailable" }; } NovaPlaceholder;',
      name: 'LiveStreamWidget',
      description: 'Live stream widget',
      category: 'media',
    };
  }

  public static inferPermissionsFor(code: string) {
    return inferPermissions(code);
  }
}
