// src/main/services/agent_orchestrator.ts
// NOVA Core orchestrator.
//
// Coordinates the AI providers with the Tool Registry, the Tool Executor and
// the Tool Builder. All tool execution flows through the registry: built-in
// tools run as audited host handlers (registered in builtin_tools.ts),
// AI-generated tools run in the sandbox.
//
// Pipeline (see docs/NOVA_ARCHITECTURE.md):
//   User Request -> Task Router -> Capability Registry Lookup
//     -> (exists) Load Existing Tool -> Execute -> Log -> Update Registry
//     -> (missing) Tool Builder -> Validate -> Test -> Review -> Register
//        -> Load -> Execute -> Log -> Update Registry
//
// Intent classification and provider selection are delegated to the Task
// Router; long-term memory is handled by the Memory Engine.
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { app } from 'electron';
import { geminiLiveBridge } from './gemini_live_bridge';
import { performSecurityAudit } from '../utils/security';
import { createToolRegistry, ToolRegistry } from './tool_registry';
import { createToolExecutor, ToolExecutor } from './tool_executor';
import { ToolBuilder } from './tool_builder';
import { TaskRunner } from './task_runner';
import { probeBuiltinHealth, registerBuiltinTools } from './builtin_tools';
import { pythonRuntime } from './python_runtime';
import { WorkspaceManager } from './workspace_manager';
import { logger } from '../core/logger';
import { ToolDefinition, ToolSynthesisPhase } from './tool_types';
import { interactionLedger } from '../db/sqlite_adapter';

export interface ISecurityAuditResult {
  passed: boolean;
  reason?: string;
}

export interface IToolDefinition {
  id: string;
  name: string;
  description: string;
  sourceCode: string;
  compiledFn: Function | null;
  status: 'pending' | 'compiled' | 'failed';
  createdAt: number;
  permissions: ToolDefinition['permissions'];
}

export interface IProgressStep {
  stepId: string;
  label: string;
  status: 'pending' | 'active' | 'completed' | 'failed';
  timestamp: number;
}

type FunctionResponsePayload = {
  id: string;
  name: string;
  response: Record<string, unknown>;
};

export class AgentOrchestrator extends EventEmitter {
  private projectRoot: string;
  private activeProject: string | null = null;

  private registry: ToolRegistry;
  private executor: ToolExecutor;
  private builder: ToolBuilder;
  private taskRunner: TaskRunner;
  private workspace: WorkspaceManager;

  private toolDeclarations: unknown[] = [];

  constructor(_apiKey: string, options: { registry?: ToolRegistry; executor?: ToolExecutor } = {}) {
    super();

    // Agent projects sandbox (relative to the working directory for dev/CI
    // compatibility; absolute paths are always enforced by resolveSandboxedPath).
    this.projectRoot = path.join(process.cwd(), 'agent_projects');

    const userData =
      typeof app?.isReady === 'function' && app.isReady()
        ? app.getPath('userData')
        : path.join(process.cwd(), '.nova-data');
    const registry =
      options.registry ??
      createToolRegistry(path.join(userData, 'tool_registry.db'), path.join(this.projectRoot, 'tools.json'));
    this.registry = registry;

    const executor = options.executor ?? createToolExecutor(this.registry);
    this.executor = executor;

    this.taskRunner = new TaskRunner(executor, registry);
    this.builder = new ToolBuilder(this.registry, this.executor);
    // NOVA workspace: internal surfaces live under the app data dir so they
    // survive restarts; the main process wires onUpdate -> renderer push.
    this.workspace = new WorkspaceManager(path.join(userData, 'workspace'));
    this.workspace.load();
    this.builder.on('tool-created', toolCreated => {
      this.emit('tool-created', toolCreated);
      this.rebuildDeclarations();
    });
    this.registry.on('tool-registered', () => this.rebuildDeclarations());
    this.registry.on('tool-updated', () => this.rebuildDeclarations());

    try {
      fs.mkdirSync(this.projectRoot, { recursive: true });
      registerBuiltinTools(this.registry, this.executor, {
        projectRoot: this.projectRoot,
        resolvePath: requested => this.resolveSandboxedPath(requested),
        resolveHostPath: requested => this.resolveHostPath(requested),
        queueAutomationTask: (kind, prompt) => this.queueAutomationTask(kind, prompt),
        builder: this.builder,
        setActiveProject: name => {
          this.activeProject = name;
        },
        getActiveProject: () => this.activeProject,
        workspace: this.workspace,
      });
      // Probe real health of Python-backed built-ins (never blocks startup).
      void probeBuiltinHealth(this.registry).catch(() => undefined);
      this.rebuildDeclarations();
    } catch (err) {
      logger.error('[agent_orchestrator] initialization failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Automation task persistence
  // ---------------------------------------------------------------------------

  private queueAutomationTask(kind: string, prompt: string): string {
    const taskId = crypto.randomUUID();
    try {
      interactionLedger.insertInteraction({
        uuid: taskId,
        timestamp_epoch: Date.now(),
        interaction_type: 'automation_trigger',
        raw_transcript_input: prompt,
        model_response_output: `Queued ${kind} task`,
        context_snapshot_json: JSON.stringify({ taskKind: kind, status: 'queued' }),
        embedding_vector_id: `v_${taskId}`,
        performance_latency_ms: 0,
      });
    } catch (err) {
      logger.error('[agent_orchestrator] failed to persist automation task', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return taskId;
  }

  // ---------------------------------------------------------------------------
  // Registry helpers
  // ---------------------------------------------------------------------------

  private rebuildDeclarations(): void {
    const declarations: any[] = [{ google_search: {} }, { function_declarations: [] }];
    for (const tool of this.registry.list()) {
      if (!tool.enabled || tool.status === 'failed' || tool.entryPoint === 'sandboxed-function') continue;
      declarations[1].function_declarations.push({
        name: tool.name,
        description: tool.description,
        behavior: 'NON_BLOCKING',
        parameters: {
          type: 'OBJECT',
          properties: {},
          required: [],
        },
      });
    }
    // Synthesized tools are exposed too so the model can call them back.
    for (const tool of this.registry.list()) {
      if (!tool.enabled || tool.status === 'failed') continue;
      if (declarations[1].function_declarations.some((d: any) => d.name === tool.name)) continue;
      declarations[1].function_declarations.push({
        name: tool.name,
        description: tool.description,
        behavior: 'NON_BLOCKING',
        parameters: {
          type: 'OBJECT',
          properties: { query: { type: 'STRING', description: 'Input passed to the tool.' } },
          required: [],
        },
      });
    }
    this.toolDeclarations = declarations;
    try {
      geminiLiveBridge.setToolDeclarations(this.toolDeclarations);
    } catch (err) {
      logger.warn('[agent_orchestrator] failed to push tool declarations', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  public getToolDeclarations(): unknown[] {
    return this.toolDeclarations;
  }

  public performSecurityAudit(code: string): ISecurityAuditResult {
    return performSecurityAudit(code);
  }

  // ---------------------------------------------------------------------------
  // Tool call handling (from Gemini Live)
  // ---------------------------------------------------------------------------

  public async handleToolCall(toolCall: any): Promise<FunctionResponsePayload[]> {
    const functionResponses: FunctionResponsePayload[] = [];
    if (!toolCall || !Array.isArray(toolCall.functionCalls)) {
      return functionResponses;
    }
    for (const fc of toolCall.functionCalls) {
      const id: string = fc?.id ?? crypto.randomUUID();
      const name: string = fc?.name ?? 'unknown_tool';
      try {
        const result = await this.executor.execute(name, fc?.args ?? {});
        functionResponses.push({
          id,
          name,
          response: result.success ? { result: result.payload } : { error: result.error ?? 'Tool execution failed' },
        });
      } catch (err: any) {
        functionResponses.push({
          id,
          name,
          response: { error: err?.message ?? 'Tool execution failed' },
        });
      }
    }
    return functionResponses;
  }

  // ---------------------------------------------------------------------------
  // Tool synthesis entry point (kept for UI + smoke-test compatibility)
  // ---------------------------------------------------------------------------

  public async generateToolFromIntent(intent: string): Promise<IToolDefinition> {
    const { tool } = await this.builder.ensureCapability(intent);
    return {
      id: tool.id,
      name: tool.name,
      description: tool.description,
      sourceCode: tool.sourceCode,
      compiledFn: null,
      status: tool.status === 'active' || tool.status === 'compiled' ? 'compiled' : 'failed',
      createdAt: tool.createdAt,
      permissions: tool.permissions,
    };
  }

  public getCurrentPhase(): ToolSynthesisPhase {
    return this.builder.getPhase();
  }

  public getProgressSteps(): IProgressStep[] {
    return this.builder.getSteps() as IProgressStep[];
  }

  public getToolRegistry(): Map<string, IToolDefinition> {
    const map = new Map<string, IToolDefinition>();
    for (const tool of this.registry.list()) {
      map.set(tool.id, {
        id: tool.id,
        name: tool.name,
        description: tool.description,
        sourceCode: tool.sourceCode,
        compiledFn: null,
        status: tool.status === 'active' || tool.status === 'compiled' ? 'compiled' : 'failed',
        createdAt: tool.createdAt,
        permissions: tool.permissions,
      });
    }
    return map;
  }

  public getRegistry(): ToolRegistry {
    return this.registry;
  }

  public getExecutor(): ToolExecutor {
    return this.executor;
  }

  public getBuilder(): ToolBuilder {
    return this.builder;
  }

  public getTaskRunner(): TaskRunner {
    return this.taskRunner;
  }

  /** The NOVA workspace manager (surfaces survive restarts). */
  public getWorkspace(): WorkspaceManager {
    return this.workspace;
  }

  /**
   * Executes a natural-language computer task through the Task Runner
   * (plan -> execute -> verify -> recover). This is the primary bridge
   * between intent and real PC action.
   */
  public async runTask(request: string): Promise<ReturnType<TaskRunner['runTask']>> {
    return this.taskRunner.runTask(request);
  }

  public listTaskCapabilities(): ReturnType<TaskRunner['listCapabilities']> {
    return this.taskRunner.listCapabilities();
  }

  private resolveSandboxedPath(requested: string): string {
    if (typeof requested !== 'string' || requested.trim().length === 0) {
      throw new Error('A non-empty relative path is required for sandboxed file operations.');
    }
    const resolved = path.resolve(this.projectRoot, requested);
    const rootWithSep = this.projectRoot.endsWith(path.sep)
      ? this.projectRoot
      : this.projectRoot + path.sep;
    if (resolved !== this.projectRoot && !resolved.startsWith(rootWithSep)) {
      throw new Error(`Path "${requested}" escapes the agent project sandbox.`);
    }
    return resolved;
  }

  /**
   * Host paths are deliberately narrower than arbitrary filesystem access.
   * Relative names are placed on Desktop; named user folders are expanded from
   * USERPROFILE. Absolute paths are accepted only inside those user folders.
   */
  private resolveHostPath(requested: string): string {
    const raw = String(requested ?? '').trim();
    if (!raw) throw new Error('A non-empty host path is required.');
    const profile = process.env.USERPROFILE ?? process.env.HOME ?? '';
    if (!profile) throw new Error('User profile path is unavailable.');
    const roots = [
      path.join(profile, 'Desktop'),
      path.join(profile, 'Documents'),
      path.join(profile, 'Downloads'),
    ].map(p => path.resolve(p));
    const namedFolder = raw.match(/^(desktop|downloads?|documents?)[\\/]*(.*)$/i);
    const base = namedFolder
      ? roots[/^desktop$/i.test(namedFolder[1]) ? 0 : /^downloads?$/i.test(namedFolder[1]) ? 2 : 1]
      : roots[0];
    const relative = namedFolder ? namedFolder[2] : raw;
    const resolved = path.resolve(path.isAbsolute(raw) ? raw : path.join(base, relative));
    const allowed = roots.some(root => resolved === root || resolved.startsWith(root + path.sep));
    if (!allowed) throw new Error('Host path must be inside Desktop, Documents, or Downloads.');
    return resolved;
  }

  public async shutdown(): Promise<void> {
    try {
      pythonRuntime.stopWorker();
    } catch (err) {
      logger.error('[agent_orchestrator] python worker stop failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    try {
      this.executor.shutdown();
    } catch (err) {
      logger.error('[agent_orchestrator] sandbox worker stop failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    try {
      this.registry.close();
    } catch (err) {
      logger.error('[agent_orchestrator] registry close failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

export const agentOrchestrator = new AgentOrchestrator(process.env.GEMINI_API_KEY ?? '');
