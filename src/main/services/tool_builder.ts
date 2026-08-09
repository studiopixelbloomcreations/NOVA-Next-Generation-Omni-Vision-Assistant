// src/main/services/tool_builder.ts
// NOVA capability engine: registry -> forge -> validate -> sandbox-test -> register -> execute -> verify/recover.
// All AI-created tools are Python tools persisted under the local NOVA tools root.
import { EventEmitter } from 'events';
import { BrowserWindow } from 'electron';
import * as crypto from 'crypto';
import { ToolRegistry } from './tool_registry';
import { ToolExecutor } from './tool_executor';
import { ToolForge } from './tool_forge';
import { NovaConfig } from '../core/config';
import { ToolDefinition, ToolSynthesisPhase, BuildOptions } from './tool_types';
import { logger } from '../core/logger';

const MAX_CAPABILITY_RECOVERY = 3;
const APPROVAL_TIMEOUT_MS = 60_000;

type ProgressStatus = 'pending' | 'active' | 'completed' | 'failed';
interface ProgressStep { stepId: string; label: string; status: ProgressStatus; timestamp: number; }
interface PendingApproval { resolve: (approved: boolean) => void; timer: NodeJS.Timeout; }

function broadcast(channel: string, payload: unknown): void {
  try {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(channel, payload);
    }
  } catch { /* renderer may not exist in headless tests */ }
}

/**
 * ToolBuilder deliberately has no JavaScript/media generation path.
 * Every newly created capability goes through ToolForge and becomes a real
 * Python file with tests + manifest on disk. Existing built-ins remain built-ins.
 */
export class ToolBuilder extends EventEmitter {
  private readonly registry: ToolRegistry;
  private readonly executor: ToolExecutor;
  private readonly forge: ToolForge;
  private phase: ToolSynthesisPhase = 'IDLE';
  private steps: ProgressStep[] = [];
  private queue: Promise<unknown> = Promise.resolve();
  private pendingApproval: PendingApproval | null = null;

  constructor(registry: ToolRegistry, executor: ToolExecutor) {
    super();
    this.registry = registry;
    this.executor = executor;
    this.forge = new ToolForge(registry);
  }

  public getPhase(): ToolSynthesisPhase { return this.phase; }
  public getSteps(): ProgressStep[] { return [...this.steps]; }

  private setPhase(phase: ToolSynthesisPhase): void {
    this.phase = phase;
    broadcast('agent-tool-synthesis-phase', { phase, steps: this.steps });
    broadcast('agent-tool-synthesis-steps', { steps: this.steps });
  }

  private step(label: string, status: ProgressStatus): ProgressStep {
    const value: ProgressStep = { stepId: crypto.randomUUID(), label, status, timestamp: Date.now() };
    this.steps.push(value);
    broadcast('agent-progress-update', { step: value, allSteps: this.steps });
    return value;
  }

  private complete(value?: ProgressStep): void {
    const target = value ?? this.steps[this.steps.length - 1];
    if (target) { target.status = 'completed'; target.timestamp = Date.now(); }
    broadcast('agent-progress-update', { allSteps: this.steps });
  }

  private fail(message: string): void {
    const target = this.steps[this.steps.length - 1];
    if (target) { target.status = 'failed'; target.timestamp = Date.now(); }
    broadcast('agent-progress-update', { step: { label: message, status: 'failed' }, allSteps: this.steps });
  }

  public ensureCapability(
    intent: string,
    options: Partial<BuildOptions> = {},
  ): Promise<{ tool: ToolDefinition; result: unknown; reused: boolean; executionOk: boolean }> {
    const run = this.queue.then(() => this.doEnsureCapability(intent, options));
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  private async doEnsureCapability(
    intent: string,
    options: Partial<BuildOptions> = {},
  ): Promise<{ tool: ToolDefinition; result: unknown; reused: boolean; executionOk: boolean }> {
    this.steps = [];
    const request = String(intent ?? '').trim();
    if (!request) throw new Error('Cannot build a capability from an empty request.');

    // 1. Search existing capabilities before creating anything.
    this.setPhase('SEARCHING_REGISTRY');
    const searchStep = this.step('Searching the local tool registry…', 'active');
    const existing = this.registry.findCapability(request);
    this.complete(searchStep);
    if (existing) {
      this.setPhase('COMPLETED');
      this.step(`Using existing capability: ${existing.name}`, 'completed');
      const result = await this.executor.execute(existing.id, { query: request, args: options.schema ?? {} });
      if (!result.success) throw new Error(result.error ?? `Existing tool '${existing.name}' failed.`);
      return { tool: existing, result: result.payload, reused: true, executionOk: true };
    }

    // 2–7. Forge is the single creation path: design, code, static audit,
    // dependency review, sandbox tests, registration and production execution.
    this.setPhase('TOOL_NOT_FOUND');
    this.step('No suitable capability exists — starting NOVA Forge.', 'completed');

    let lastError = '';
    for (let attempt = 1; attempt <= MAX_CAPABILITY_RECOVERY; attempt++) {
      try {
        this.setPhase('DESIGNING_ARCHITECTURE');
        this.step(`Planning capability architecture (attempt ${attempt}/${MAX_CAPABILITY_RECOVERY})…`, 'completed');
        this.setPhase('WRITING_CODE');
        this.step('Groq is selecting the coding model and generating real Python source…', 'active');

        const enrichedIntent = lastError
          ? `${request}\n\nPrevious attempt failed in production. Diagnose and correct it before generating the next tool. Failure: ${lastError.slice(0, 2000)}`
          : request;
        const forgeResult = await this.forge.forgeTool(enrichedIntent);
        this.complete();

        this.setPhase('DEPLOYING_TOOL');
        this.step(`Registered Python capability: ${forgeResult.tool.name}`, 'completed');
        this.setPhase('COMPLETED');
        this.step(forgeResult.productionOk ? 'Capability executed successfully on the real machine.' : 'Capability was created but production verification failed.', forgeResult.productionOk ? 'completed' : 'failed');

        this.emit('tool-created', { tool: forgeResult.tool, execution: forgeResult.execution });
        broadcast('agent-tool-created', {
          id: forgeResult.tool.id,
          name: forgeResult.tool.name,
          technicalId: forgeResult.tool.technicalId,
          description: forgeResult.tool.description,
          status: forgeResult.tool.status,
          sourcePath: forgeResult.tool.sourcePath,
          entryPoint: forgeResult.tool.entryPoint,
          payload: forgeResult.execution,
        });
        logger.audit('tool.build', forgeResult.productionOk ? 'ok' : 'failed', {
          toolId: forgeResult.tool.id,
          toolName: forgeResult.tool.name,
          technicalId: forgeResult.tool.technicalId,
          attempt,
          repairCount: forgeResult.repairCount,
          productionOk: forgeResult.productionOk,
        });

        if (forgeResult.productionOk) {
          return { tool: forgeResult.tool, result: forgeResult.execution, reused: false, executionOk: true };
        }
        lastError = typeof forgeResult.execution === 'string'
          ? forgeResult.execution
          : JSON.stringify(forgeResult.execution ?? 'production execution failed');
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        this.fail(lastError);
        logger.warn('[tool_builder] capability attempt failed; recovery will continue', { attempt, error: lastError });
        if (attempt === MAX_CAPABILITY_RECOVERY) {
          this.setPhase('FAILED');
          throw new Error(`NOVA could not complete the requested capability after ${MAX_CAPABILITY_RECOVERY} build/recovery attempts: ${lastError}`);
        }
      }
    }

    this.setPhase('FAILED');
    throw new Error(`Capability creation failed: ${lastError || 'unknown failure'}`);
  }

  /** Optional approval hook retained for compatibility; NOVA defaults to autonomous execution. */
  public approvePendingTool(): boolean {
    if (!this.pendingApproval) return false;
    this.pendingApproval.resolve(true);
    clearTimeout(this.pendingApproval.timer);
    this.pendingApproval = null;
    return true;
  }

  public rejectPendingTool(): boolean {
    if (!this.pendingApproval) return false;
    this.pendingApproval.resolve(false);
    clearTimeout(this.pendingApproval.timer);
    this.pendingApproval = null;
    return true;
  }

  public hasPendingApproval(): boolean { return this.pendingApproval !== null; }

  public static inferPermissionsFor(_code: string) {
    return [];
  }
}
