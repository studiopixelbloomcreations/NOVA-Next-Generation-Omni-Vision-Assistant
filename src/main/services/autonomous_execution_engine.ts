// NOVA autonomous agent engines.
// These engines deliberately separate discovery, planning, synthesis, testing,
// verification and presentation so the assistant can recover from failures
// instead of collapsing the whole request into a single model call.
import { EventEmitter } from 'events';
import * as crypto from 'crypto';
import * as fs from 'fs';
import { ToolRegistry } from './tool_registry';
import { ToolExecutor } from './tool_executor';
import { ToolForge, ForgeResult } from './tool_forge';
import { ToolDefinition, ToolExecutionResult } from './tool_types';
import { aiProviderRegistry, AiProvider } from './ai_provider';
import { logger } from '../core/logger';
import { NovaConfig } from '../core/config';

export interface AgentPlanStep {
  id: string;
  goal: string;
  capability: string;
  tool: string | null;
  args: Record<string, unknown>;
  verification: string;
}

export interface AgentPlan {
  objective: string;
  steps: AgentPlanStep[];
}

export interface EngineStepResult {
  step: AgentPlanStep;
  tool: ToolDefinition | null;
  success: boolean;
  payload: unknown;
  error: string | null;
  attempts: number;
  verification: { passed: boolean; detail: string };
}

export interface AutonomousTrace {
  taskId: string;
  request: string;
  status: 'completed' | 'failed' | 'partial';
  plan: AgentPlan;
  results: EngineStepResult[];
  startedAt: number;
  completedAt: number;
  summary: string;
}

const MAX_PLAN_STEPS = 12;
const MAX_RETRIES_PER_STEP = 3;
const PLAN_TIMEOUT_MS = 20_000;

function jsonExtract(text: string): unknown {
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('AI planner returned no JSON object');
  return JSON.parse(cleaned.slice(start, end + 1));
}

export class ToolAvailabilityEngine {
  constructor(private readonly registry: ToolRegistry) {}

  inspect(request: string): { exact: ToolDefinition | null; candidates: ToolDefinition[]; catalog: string } {
    const exact = this.registry.findCapability(request);
    const candidates = this.registry.searchCapability(request);
    const catalog = this.registry
      .list()
      .filter(t => t.enabled && t.status !== 'failed')
      .map(t => `${t.name} [${t.category}] — ${t.description} — runtime=${t.entryPoint} — health=${t.health}`)
      .join('\n');
    return { exact, candidates, catalog };
  }
}

export class CodingAgentSelector {
  select(): AiProvider | null {
    const candidates = aiProviderRegistry
      .all()
      .filter(p => p.isConfigured())
      .sort((a, b) => {
        const rank = (p: AiProvider): number => {
          if (p.id === 'groq') return 100;
          if (p.id === 'gemini') return 80;
          return 10;
        };
        return rank(b) - rank(a);
      });
    return candidates[0] ?? null;
  }
}

export class PromptingEngine {
  buildPlanPrompt(request: string, catalog: string): string {
    return `You are NOVA's autonomous planning engine. You are not the conversational voice. You are the execution planner.\n\nUSER OBJECTIVE:\n${request}\n\nAVAILABLE TOOLS:\n${catalog || '(none)'}\n\nProduce a concrete executable plan. Prefer existing tools. If a required capability is missing, mark tool as null and provide the capability that must be created. Do not ask the user questions. Infer sensible defaults. Each step must have an observable success condition. Keep the plan <= ${MAX_PLAN_STEPS} steps.\n\nReturn ONLY JSON:\n{"objective":"...","steps":[{"id":"1","goal":"...","capability":"...","tool":null,"args":{},"verification":"..."}]}`;
  }

  buildToolRepairPrompt(request: string, failure: string): string {
    return `NOVA tool repair task. The requested capability is: ${request}\nThe previous implementation failed with:\n${failure.slice(0, 5000)}\nGenerate a corrected implementation through the Tool Forge. Do not weaken the requested behavior. Preserve real execution and objective verification.`;
  }
}

export class ToolTestingEngine {
  constructor(private readonly forge: ToolForge) {}

  async test(toolPath: string, testPath: string): Promise<{ passed: boolean; output: string }> {
    return this.forge.sandboxTest(toolPath, testPath);
  }
}

export class ToolVerificationEngine {
  constructor(private readonly providerSelector: CodingAgentSelector) {}

  objective(payload: unknown, expected: string): { passed: boolean; detail: string } {
    if (payload === null || payload === undefined) return { passed: false, detail: 'no result returned' };
    if (typeof payload === 'object') {
      const p = payload as Record<string, unknown>;
      if (p.success === false) return { passed: false, detail: String(p.error ?? 'tool reported failure') };
      if (p.success === true) return { passed: true, detail: 'tool reported success' };
    }
    return { passed: true, detail: `result returned for verification target: ${expected.slice(0, 160)}` };
  }

  async modelVerify(request: string, step: AgentPlanStep, payload: unknown): Promise<{ passed: boolean; detail: string }> {
    const provider = this.providerSelector.select();
    if (!provider) return this.objective(payload, step.verification);
    try {
      const raw = await provider.generate(
        `Verify an action NOVA just performed.\nUSER REQUEST: ${request}\nSTEP: ${step.goal}\nEXPECTED: ${step.verification}\nRESULT: ${JSON.stringify(payload).slice(0, 5000)}\nReturn ONLY JSON: {"passed":true|false,"detail":"short factual reason"}. Do not invent evidence.`,
        { timeoutMs: 8_000, maxOutputTokens: 256 },
      );
      const parsed = jsonExtract(raw) as { passed?: boolean; detail?: string };
      if (typeof parsed.passed === 'boolean') return { passed: parsed.passed, detail: String(parsed.detail ?? '') };
    } catch (err) {
      logger.debug('[verification] model verification unavailable', { error: err instanceof Error ? err.message : String(err) });
    }
    return this.objective(payload, step.verification);
  }
}

export class OutputEngine {
  summarize(trace: AutonomousTrace): string {
    const completed = trace.results.filter(r => r.success && r.verification.passed).length;
    const failed = trace.results.length - completed;
    if (trace.status === 'completed') {
      return `Completed the requested objective. ${completed} execution step${completed === 1 ? '' : 's'} verified successfully.`;
    }
    if (completed > 0) return `Completed ${completed} verified step${completed === 1 ? '' : 's'}, but ${failed} step${failed === 1 ? '' : 's'} could not be verified.`;
    return `The objective could not be verified. NOVA exhausted its available execution strategies without claiming success.`;
  }
}

export class AutonomousExecutionEngine extends EventEmitter {
  private readonly availability: ToolAvailabilityEngine;
  private readonly selector = new CodingAgentSelector();
  private readonly prompting = new PromptingEngine();
  private readonly forge: ToolForge;
  private readonly testing: ToolTestingEngine;
  private readonly verification = new ToolVerificationEngine(this.selector);
  private readonly output = new OutputEngine();

  constructor(private readonly registry: ToolRegistry, private readonly executor: ToolExecutor) {
    super();
    this.availability = new ToolAvailabilityEngine(registry);
    this.forge = new ToolForge(registry);
    this.testing = new ToolTestingEngine(this.forge);
    this.hydrateToolsFromDisk();
  }

  /** Rehydrates real Python tools from the persistent local tools directory. */
  private hydrateToolsFromDisk(): void {
    const root = NovaConfig.paths.toolsRoot;
    try {
      if (!fs.existsSync(root)) return;
      for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const dir = `${root}/${entry.name}`;
        const manifestPath = `${dir}/manifest.json`;
        const toolPath = `${dir}/tool.py`;
        if (!fs.existsSync(manifestPath) || !fs.existsSync(toolPath)) continue;
        try {
          const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
          const sourceCode = fs.readFileSync(toolPath, 'utf8');
          const technicalId = String(manifest.technicalId ?? entry.name);
          const existing = this.registry.list().find(t => t.technicalId === technicalId || t.sourcePath === toolPath);
          if (existing) continue;
          const tool: ToolDefinition = {
            id: crypto.randomUUID(),
            name: String(manifest.displayName ?? technicalId),
            technicalId,
            description: String(manifest.description ?? `Persistent NOVA tool: ${technicalId}`),
            category: String(manifest.category ?? 'ai-generated'),
            author: 'ai',
            version: String(manifest.version ?? '1.0.0'),
            dependencies: Array.isArray(manifest.dependencies) ? manifest.dependencies.map(String) : [],
            entryPoint: 'python',
            sourcePath: toolPath,
            capabilities: Array.isArray(manifest.capabilities) ? manifest.capabilities.map(String) : [],
            config: {},
            permissions: Array.isArray(manifest.permissions) ? manifest.permissions as ToolDefinition['permissions'] : [],
            sourceCode,
            sourceHash: String(manifest.sourceHash ?? ToolRegistry.hashSource(sourceCode)),
            enabled: true,
            status: 'active',
            createdAt: Number(manifest.createdAt ?? Date.now()),
            updatedAt: Date.now(),
            lastExecutedAt: null,
            lastValidationDate: Date.now(),
            executionCount: 0,
            successCount: 0,
            totalExecutionTimeMs: 0,
            health: 'unknown',
            versions: [],
          };
          this.registry.register(tool);
        } catch (err) {
          logger.debug('[autonomy] skipped invalid persisted tool', { path: manifestPath, error: err instanceof Error ? err.message : String(err) });
        }
      }
    } catch (err) {
      logger.warn('[autonomy] persistent tool hydration failed', { error: err instanceof Error ? err.message : String(err) });
    }
  }

  private emitProgress(label: string, status: 'active' | 'completed' | 'failed'): void {
    this.emit('progress', { label, status, timestamp: Date.now() });
  }

  private async plan(request: string): Promise<AgentPlan> {
    const provider = this.selector.select();
    const info = this.availability.inspect(request);
    if (!provider) {
      if (info.exact) {
        return { objective: request, steps: [{ id: '1', goal: request, capability: info.exact.description, tool: info.exact.name, args: { query: request }, verification: 'tool returns success and a result' }] };
      }
      return { objective: request, steps: [{ id: '1', goal: request, capability: request, tool: null, args: { query: request }, verification: 'the requested operation completes successfully' }] };
    }
    const raw = await provider.generate(this.prompting.buildPlanPrompt(request, info.catalog), { timeoutMs: PLAN_TIMEOUT_MS, maxOutputTokens: 2048 });
    const parsed = jsonExtract(raw) as Partial<AgentPlan>;
    const rawSteps = Array.isArray(parsed.steps) ? parsed.steps : [];
    const steps: AgentPlanStep[] = rawSteps.slice(0, MAX_PLAN_STEPS).map((s, i) => ({
      id: String(s?.id ?? i + 1),
      goal: String(s?.goal ?? request),
      capability: String(s?.capability ?? s?.goal ?? request),
      tool: s?.tool ? String(s.tool) : null,
      args: s?.args && typeof s.args === 'object' ? s.args as Record<string, unknown> : { query: request },
      verification: String(s?.verification ?? 'the operation completes successfully'),
    }));
    if (!steps.length) throw new Error('planner returned an empty executable plan');
    return { objective: String(parsed.objective ?? request), steps };
  }

  private async ensureTool(step: AgentPlanStep): Promise<{ tool: ToolDefinition; execution?: ToolExecutionResult }> {
    const existing = step.tool ? (this.registry.get(step.tool) ?? this.registry.getByName(step.tool)) : this.registry.findCapability(step.capability);
    if (existing) return { tool: existing };
    this.emitProgress(`Creating capability: ${step.capability}`, 'active');
    const forgeResult: ForgeResult = await this.forge.forgeTool(step.capability);
    if (!forgeResult.productionOk) throw new Error(`Forged tool '${forgeResult.tool.name}' failed its production execution`);
    this.emitProgress(`Capability online: ${forgeResult.tool.name}`, 'completed');
    const execution = forgeResult.execution as ToolExecutionResult | null | undefined;
    return { tool: forgeResult.tool, execution: execution && typeof execution === 'object' && 'success' in execution ? execution : undefined };
  }

  async run(request: string): Promise<AutonomousTrace> {
    const taskId = crypto.randomUUID();
    const startedAt = Date.now();
    this.emitProgress('Inspecting available capabilities', 'active');
    let plan: AgentPlan;
    try {
      plan = await this.plan(request);
      this.emitProgress('Execution plan ready', 'completed');
    } catch (err) {
      const fallback = this.availability.inspect(request);
      plan = { objective: request, steps: [{ id: '1', goal: request, capability: request, tool: fallback.exact?.name ?? null, args: { query: request }, verification: 'the requested operation completes successfully' }] };
      this.emitProgress(`Planner recovery: ${err instanceof Error ? err.message : String(err)}`, 'completed');
    }

    const results: EngineStepResult[] = [];
    let overall = true;
    for (const step of plan.steps) {
      let final: EngineStepResult | null = null;
      for (let attempt = 1; attempt <= MAX_RETRIES_PER_STEP; attempt++) {
        try {
          this.emitProgress(`${step.goal} — attempt ${attempt}`, 'active');
          const ensured = await this.ensureTool(step);
          const tool = ensured.tool;
          const args = { ...step.args, query: step.args.query ?? request };
          const execution = ensured.execution ?? await this.executor.executeDefinition(tool, args);
          if (!execution.success) throw new Error(execution.error ?? 'tool execution failed');
          const verification = await this.verification.modelVerify(request, step, execution.payload);
          final = { step, tool, success: verification.passed, payload: execution.payload, error: verification.passed ? null : verification.detail, attempts: attempt, verification };
          if (verification.passed) {
            this.emitProgress(`${step.goal} — verified`, 'completed');
            break;
          }
          throw new Error(verification.detail || 'verification failed');
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          final = { step, tool: final?.tool ?? null, success: false, payload: final?.payload ?? null, error: message, attempts: attempt, verification: { passed: false, detail: message } };
          this.emitProgress(`${step.goal} — ${message}`, attempt === MAX_RETRIES_PER_STEP ? 'failed' : 'active');
        }
      }
      if (!final) {
        final = { step, tool: null, success: false, payload: null, error: 'no execution result', attempts: 0, verification: { passed: false, detail: 'no execution result' } };
      }
      results.push(final);
      if (!final.success) { overall = false; break; }
    }

    const trace: AutonomousTrace = {
      taskId,
      request,
      status: overall ? 'completed' : results.length ? 'partial' : 'failed',
      plan,
      results,
      startedAt,
      completedAt: Date.now(),
      summary: '',
    };
    trace.summary = this.output.summarize(trace);
    this.emit('completed', trace);
    return trace;
  }
}
