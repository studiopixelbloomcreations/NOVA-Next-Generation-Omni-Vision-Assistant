// src/main/services/agent_orchestrator.ts
// NOVA Core orchestrator. Coordinates providers, registry, executor, Python Forge, Task Runner and workspace.
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
import { TaskRunner, TaskTrace } from './task_runner';
import { probeBuiltinHealth, registerBuiltinTools } from './builtin_tools';
import { pythonRuntime } from './python_runtime';
import { WorkspaceManager } from './workspace_manager';
import { logger } from '../core/logger';
import { ToolDefinition, ToolSynthesisPhase } from './tool_types';
import { interactionLedger } from '../db/sqlite_adapter';

export interface ISecurityAuditResult { passed: boolean; reason?: string; }
export interface IToolDefinition { id: string; name: string; description: string; sourceCode: string; compiledFn: Function | null; status: 'pending' | 'compiled' | 'failed'; createdAt: number; permissions: ToolDefinition['permissions']; }
export interface IProgressStep { stepId: string; label: string; status: 'pending' | 'active' | 'completed' | 'failed'; timestamp: number; }
type FunctionResponsePayload = { id: string; name: string; response: Record<string, unknown>; };

type CapabilityLike = { id: string; label: string; description: string; patterns: RegExp[]; plan: Array<{ tool: string; args: (request: string, previous?: unknown) => Record<string, unknown>; label: string; verify?: (payload: unknown) => { passed: boolean; detail: string } }>; };

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
    this.projectRoot = path.join(process.cwd(), 'agent_projects');
    const userData = typeof app?.isReady === 'function' && app.isReady() ? app.getPath('userData') : path.join(process.cwd(), '.nova-data');
    this.registry = options.registry ?? createToolRegistry(path.join(userData, 'tool_registry.db'), path.join(this.projectRoot, 'tools.json'));
    this.executor = options.executor ?? createToolExecutor(this.registry);
    this.taskRunner = new TaskRunner(this.executor, this.registry);
    this.builder = new ToolBuilder(this.registry, this.executor);

    // The existing TaskRunner remains the fast path. When it cannot map a
    // request to a built-in plan, expose a synthetic hand-off so every typed or
    // spoken request reaches AgentOrchestrator.runTask and therefore the Forge.
    const originalMatch = this.taskRunner.matchCapability.bind(this.taskRunner);
    this.taskRunner.matchCapability = ((request: string): CapabilityLike | null => {
      const known = originalMatch(request);
      if (known) return known as unknown as CapabilityLike;
      return {
        id: 'autonomous_capability',
        label: 'Autonomous capability execution',
        description: 'Search the registry and, when necessary, create and verify a real Python capability.',
        patterns: [/.*/],
        plan: [{ tool: '__nova_autonomous_forge_handoff__', args: req => ({ query: req }), label: 'Hand off to autonomous Forge' }],
      };
    }) as typeof this.taskRunner.matchCapability;

    this.workspace = new WorkspaceManager(path.join(userData, 'workspace'));
    this.workspace.load();
    this.builder.on('tool-created', toolCreated => { this.emit('tool-created', toolCreated); this.rebuildDeclarations(); });
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
        setActiveProject: name => { this.activeProject = name; },
        getActiveProject: () => this.activeProject,
        workspace: this.workspace,
      });
      void probeBuiltinHealth(this.registry).catch(() => undefined);
      this.rebuildDeclarations();
    } catch (err) { logger.error('[agent_orchestrator] initialization failed', { error: err instanceof Error ? err.message : String(err) }); }
  }

  private queueAutomationTask(kind: string, prompt: string): string {
    const taskId = crypto.randomUUID();
    try { interactionLedger.insertInteraction({ uuid: taskId, timestamp_epoch: Date.now(), interaction_type: 'automation_trigger', raw_transcript_input: prompt, model_response_output: `Queued ${kind} task`, context_snapshot_json: JSON.stringify({ taskKind: kind, status: 'queued' }), embedding_vector_id: `v_${taskId}`, performance_latency_ms: 0 }); }
    catch (err) { logger.error('[agent_orchestrator] failed to persist automation task', { error: err instanceof Error ? err.message : String(err) }); }
    return taskId;
  }

  private rebuildDeclarations(): void {
    const declarations: any[] = [{ google_search: {} }, { function_declarations: [] }];
    for (const tool of this.registry.list()) {
      if (!tool.enabled || tool.status === 'failed' || tool.entryPoint === 'sandboxed-function') continue;
      declarations[1].function_declarations.push({ name: tool.name, description: tool.description, behavior: 'NON_BLOCKING', parameters: { type: 'OBJECT', properties: {}, required: [] } });
    }
    for (const tool of this.registry.list()) {
      if (!tool.enabled || tool.status === 'failed') continue;
      if (declarations[1].function_declarations.some((d: any) => d.name === tool.name)) continue;
      declarations[1].function_declarations.push({ name: tool.name, description: tool.description, behavior: 'NON_BLOCKING', parameters: { type: 'OBJECT', properties: { query: { type: 'STRING', description: 'Input passed to the tool.' } }, required: [] } });
    }
    this.toolDeclarations = declarations;
    try { geminiLiveBridge.setToolDeclarations(this.toolDeclarations); } catch (err) { logger.warn('[agent_orchestrator] failed to push tool declarations', { error: err instanceof Error ? err.message : String(err) }); }
  }

  public getToolDeclarations(): unknown[] { return this.toolDeclarations; }
  public performSecurityAudit(code: string): ISecurityAuditResult { return performSecurityAudit(code); }

  public async handleToolCall(toolCall: any): Promise<FunctionResponsePayload[]> {
    const functionResponses: FunctionResponsePayload[] = [];
    if (!toolCall || !Array.isArray(toolCall.functionCalls)) return functionResponses;
    for (const fc of toolCall.functionCalls) {
      const id: string = fc?.id ?? crypto.randomUUID(); const name: string = fc?.name ?? 'unknown_tool';
      try { const result = await this.executor.execute(name, fc?.args ?? {}); functionResponses.push({ id, name, response: result.success ? { result: result.payload } : { error: result.error ?? 'Tool execution failed' } }); }
      catch (err: any) { functionResponses.push({ id, name, response: { error: err?.message ?? 'Tool execution failed' } }); }
    }
    return functionResponses;
  }

  public async generateToolFromIntent(intent: string): Promise<IToolDefinition> {
    const { tool } = await this.builder.ensureCapability(intent);
    return { id: tool.id, name: tool.name, description: tool.description, sourceCode: tool.sourceCode, compiledFn: null, status: tool.status === 'active' || tool.status === 'compiled' ? 'compiled' : 'failed', createdAt: tool.createdAt, permissions: tool.permissions };
  }
  public getCurrentPhase(): ToolSynthesisPhase { return this.builder.getPhase(); }
  public getProgressSteps(): IProgressStep[] { return this.builder.getSteps() as IProgressStep[]; }
  public getToolRegistry(): Map<string, IToolDefinition> { const map = new Map<string, IToolDefinition>(); for (const tool of this.registry.list()) map.set(tool.id, { id: tool.id, name: tool.name, description: tool.description, sourceCode: tool.sourceCode, compiledFn: null, status: tool.status === 'active' || tool.status === 'compiled' ? 'compiled' : 'failed', createdAt: tool.createdAt, permissions: tool.permissions }); return map; }
  public getRegistry(): ToolRegistry { return this.registry; }
  public getExecutor(): ToolExecutor { return this.executor; }
  public getBuilder(): ToolBuilder { return this.builder; }
  public getTaskRunner(): TaskRunner { return this.taskRunner; }
  public getWorkspace(): WorkspaceManager { return this.workspace; }

  /** Fast built-in plans first; any failed/unmatched plan is handed to Forge. */
  public async runTask(request: string): Promise<TaskTrace> {
    const trace = await this.taskRunner.runTask(request);
    if (trace.status !== 'failed') return trace;
    try {
      const built = await this.builder.ensureCapability(request);
      return {
        taskId: `forge_task_${Date.now()}_${Math.floor(Math.random() * 1e6)}`,
        request,
        status: built.executionOk ? 'completed' : 'failed',
        steps: [{ stepId: 'forge', label: `Forged and executed: ${built.tool.name}`, tool: built.tool.name, args: { query: request }, attempts: 1, status: built.executionOk ? 'completed' : 'failed', result: built.result, error: built.executionOk ? undefined : 'production execution failed' }],
        toolsUsed: [built.tool.name], startTime: Date.now(), endTime: Date.now(), summary: built.executionOk ? `Completed with ${built.tool.name}. ${JSON.stringify(built.result).slice(0, 800)}` : `Forged capability ${built.tool.name} but execution failed.`,
      };
    } catch (err) {
      return { ...trace, summary: `${trace.summary} Forge recovery failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  public listTaskCapabilities(): ReturnType<TaskRunner['listCapabilities']> { return this.taskRunner.listCapabilities(); }
  private resolveSandboxedPath(requested: string): string { if (typeof requested !== 'string' || requested.trim().length === 0) throw new Error('A non-empty relative path is required for sandboxed file operations.'); const resolved = path.resolve(this.projectRoot, requested); const rootWithSep = this.projectRoot.endsWith(path.sep) ? this.projectRoot : this.projectRoot + path.sep; if (resolved !== this.projectRoot && !resolved.startsWith(rootWithSep)) throw new Error(`Path "${requested}" escapes the agent project sandbox.`); return resolved; }
  private resolveHostPath(requested: string): string { const raw = String(requested ?? '').trim(); if (!raw) throw new Error('A non-empty host path is required.'); const profile = process.env.USERPROFILE ?? process.env.HOME ?? ''; if (!profile) throw new Error('User profile path is unavailable.'); const roots = [path.join(profile, 'Desktop'), path.join(profile, 'Documents'), path.join(profile, 'Downloads')].map(p => path.resolve(p)); const namedFolder = raw.match(/^(desktop|downloads?|documents?)[\\/]*(.*)$/i); const base = namedFolder ? roots[/^desktop$/i.test(namedFolder[1]) ? 0 : /^downloads?$/i.test(namedFolder[1]) ? 2 : 1] : roots[0]; const relative = namedFolder ? namedFolder[2] : raw; const resolved = path.resolve(path.isAbsolute(raw) ? raw : path.join(base, relative)); if (!roots.some(root => resolved === root || resolved.startsWith(root + path.sep))) throw new Error('Host path must be inside Desktop, Documents, or Downloads.'); return resolved; }
  public async shutdown(): Promise<void> { try { pythonRuntime.stopWorker(); } catch (err) { logger.error('[agent_orchestrator] python worker stop failed', { error: err instanceof Error ? err.message : String(err) }); } try { this.executor.shutdown(); } catch (err) { logger.error('[agent_orchestrator] sandbox worker stop failed', { error: err instanceof Error ? err.message : String(err) }); } try { this.registry.close(); } catch (err) { logger.error('[agent_orchestrator] registry close failed', { error: err instanceof Error ? err.message : String(err) }); } }
}

export const agentOrchestrator = new AgentOrchestrator(process.env.GEMINI_API_KEY ?? '');
