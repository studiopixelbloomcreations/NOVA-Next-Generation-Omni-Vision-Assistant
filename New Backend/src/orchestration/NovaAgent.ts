// New Backend — orchestration/NovaAgent.ts
// NovaAgent — the master execution loop. Wires every engine into a single
// coherent intelligence:
//   Input -> Intent -> Memory -> Environment -> Capability -> Plan -> Agent ->
//   Reason -> Execute -> Verify -> Recover/Replan -> Complete -> Memory update.
// NOVA is the orchestrator; the user supplies a goal, not an implementation.
import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { statSync } from 'node:fs';
import type {
  ExecutionLedgerEntry,
  RequestEnvelope,
  StepResult,
  TaskStatus,
} from '../contracts/domain.js';
import { IntentEngine } from '../intent/IntentEngine.js';
import { MemoryEngine } from '../memory/MemoryEngine.js';
import { EnvironmentEngine } from '../environment/EnvironmentEngine.js';
import { CapabilityDiscoveryEngine } from '../capability/CapabilityDiscoveryEngine.js';
import { PlanningEngine } from '../planning/PlanningEngine.js';
import { AgentSelector } from '../reasoning/AgentSelector.js';
import { PromptEngine } from '../reasoning/PromptEngine.js';
import { ToolForge } from '../forge/ToolForge.js';
import { ValidationEngine } from '../validation/ValidationEngine.js';
import { ToolTestingEngine } from '../testing/ToolTestingEngine.js';
import { ExecutionEngine } from '../execution/ExecutionEngine.js';
import { VerificationEngine } from '../verification/VerificationEngine.js';
import { RecoveryEngine } from '../recovery/RecoveryEngine.js';
import { ToolLibrary } from '../persistence/tool_library.js';
import { ExecutionLedger } from '../persistence/execution_ledger.js';
import { PythonRuntimeBridge } from '../execution/PythonRuntimeBridge.js';
import { TelemetryEngine } from '../telemetry/TelemetryEngine.js';
import { WorkspaceEngine } from '../workspace/WorkspaceEngine.js';
import { Nova2Config } from '../core/config.js';
import { logger } from '../core/logger.js';
import { StateMachine } from '../lifecycle/StateMachine.js';
import { LearningEngine } from '../maintenance/LearningEngine.js';
import { ErrorObservabilityEngine } from '../maintenance/ErrorObservabilityEngine.js';

export interface NovaResult {
  entry: ExecutionLedgerEntry;
  status: TaskStatus;
  summary: string;
  payloads: unknown[];
  reusedTool: boolean;
}

export class NovaAgent extends EventEmitter {
  private intentEngine: IntentEngine;
  private memory: MemoryEngine;
  private environment: EnvironmentEngine;
  private discovery: CapabilityDiscoveryEngine;
  private planning: PlanningEngine;
  private selector: AgentSelector;
  private prompts: PromptEngine;
  private forge: ToolForge;
  private validator: ValidationEngine;
  private tester: ToolTestingEngine;
  private executor: ExecutionEngine;
  private verification: VerificationEngine;
  private recovery: RecoveryEngine;
  private ledger: ExecutionLedger;
  private telemetry: TelemetryEngine;
  private workspace: WorkspaceEngine;
  private stateMachine: StateMachine;
  private learning: LearningEngine;
  private errorObservability: ErrorObservabilityEngine;

  constructor(
    private readonly library: ToolLibrary,
    memory: MemoryEngine,
    ledger: ExecutionLedger,
    telemetry: TelemetryEngine,
    workspace: WorkspaceEngine,
    environment: EnvironmentEngine,
    selector: AgentSelector,
    bridge: PythonRuntimeBridge,
    providerSelectFn: () => ReturnType<AgentSelector['trySelect']>,
    stateMachine?: StateMachine,
    learning?: LearningEngine,
    errorObservability?: ErrorObservabilityEngine,
  ) {
    super();
    this.memory = memory;
    this.ledger = ledger;
    this.telemetry = telemetry;
    this.workspace = workspace;
    this.environment = environment;
    this.selector = selector;
    this.prompts = new PromptEngine();
    this.intentEngine = new IntentEngine(this.prompts);
    this.discovery = new CapabilityDiscoveryEngine(library);
    this.planning = new PlanningEngine(this.discovery);
    this.validator = new ValidationEngine(bridge);
    this.tester = new ToolTestingEngine(bridge);
    this.forge = new ToolForge(library, selector, this.validator, this.tester);
    this.executor = new ExecutionEngine(library, bridge);
    this.verification = new VerificationEngine(library, providerSelectFn);
    this.recovery = new RecoveryEngine();
    this.stateMachine = stateMachine ?? new StateMachine();
    this.learning = learning ?? new LearningEngine(memory);
    this.errorObservability = errorObservability ?? new ErrorObservabilityEngine(Nova2Config.paths.userData);
  }

  get engines() {
    return {
      intent: this.intentEngine,
      memory: this.memory,
      discovery: this.discovery,
      planning: this.planning,
      forge: this.forge,
      executor: this.executor,
      verification: this.verification,
      recovery: this.recovery,
      workspace: this.workspace,
    };
  }

  getPromptEngine(): PromptEngine {
    return this.prompts;
  }

  /**
   * Execute a full turn end-to-end and return a structured result + ledger entry.
   * The ledger guards against duplicate execution of the same requestId.
   */
  async run(envelope: RequestEnvelope, opts: { skipDuplicateCheck?: boolean } = {}): Promise<NovaResult> {
    const t0 = Date.now();
    this.emit('activity', { level: 'info', message: `Request received: ${envelope.transcript.slice(0, 80)}` });

    if (!opts.skipDuplicateCheck && this.ledger.isExecuted(envelope.requestId)) {
      const dup = this.ledger.all().find(e => e.requestId === envelope.requestId);
      return {
        entry: dup ?? null as never,
        status: 'completed',
        summary: 'Request already executed; duplicate execution prevented.',
        payloads: [],
        reusedTool: false,
      };
    }

    const ids = this.ledger.openEntry(envelope.transcript);
    const startedAt = ids.startedAt;
    let status: TaskStatus = 'failed';
    let plan = null;
    let intent = null;
    let reusedTool = false;
    const payloads: unknown[] = [];
    const errors: string[] = [];
    let retries = 0;
    const stepResults: StepResult[] = [];

    try {
      // 1) Intent.
      this.stateMachine.transition('UNDERSTANDING');
      const providerForIntent = this.selector.trySelect('reasoning');
      intent = await this.intentEngine.classify(envelope, providerForIntent);
      this.emit('activity', { level: 'info', message: `Intent: ${intent.kind}` });

      // 2) Memory retrieval (relevant, not a full dump).
      const memory = await this.memory.search(envelope.transcript);
      envelope.memoryContext = memory.map(m => m.content);

      // 3) Environment observation.
      const env = await this.environment.observe();
      envelope.environmentSnapshot = env;

      // 4) Capability discovery + planning.
      this.stateMachine.transition('PLANNING');
      const tPlan = Date.now();
      const provider = this.selector.trySelect('planning');
      plan = await this.planning.plan(envelope, intent, memory, provider);
      this.telemetry.record('planning', Date.now() - tPlan, true);

      // 5) Execute each step with verification + recovery.
      for (const step of plan.steps) {
        const stepResult = await this.executeStep(envelope, step, memory);
        stepResults.push(stepResult);
        payloads.push(stepResult.payload);
        if (!stepResult.success) {
          errors.push(stepResult.error ?? 'step failed');
          retries += stepResult.attempts - 1;
          if (stepResult.attempts > 1) retries += stepResult.attempts - 1;
          if (stepResult.verification.passed) {
            status = 'completed';
          } else {
            status = stepResults.length > 1 ? 'partial' : 'failed';
          }
          break;
        }
        if (stepResult.verification.passed) status = 'completed';
      }
      if (stepResults.length > 0 && stepResults.every(s => s.success && s.verification.passed)) status = 'completed';
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push(message);
      this.errorObservability.capture({ subsystem: 'agent', message, requestId: envelope.requestId, taskId: ids.taskId }, err);
      logger.error('[nova_agent] turn failed', { error: message });
    }
    // Learn from the outcome so future requests leverage prior knowledge.
    this.learning.learnFromTask({
      requestId: envelope.requestId,
      taskId: ids.taskId,
      executionId: ids.executionId,
      transcript: envelope.transcript,
      intent,
      plan,
      steps: stepResults,
      status,
      retries,
      errors,
      latencyMs: Date.now() - t0,
      startedAt,
      completedAt: Date.now(),
      summary: '',
      id: ids.id,
      agentProviderId: null,
      verification: { passed: status === 'completed', detail: '' },
    } as ExecutionLedgerEntry);

    const latencyMs = Date.now() - t0;
    this.telemetry.record('request', latencyMs, status === 'completed', { requestId: envelope.requestId });
    this.telemetry.record('overall', latencyMs, status === 'completed');

    const summary = this.buildSummary(status, stepResults, intent?.label);
    const entry: ExecutionLedgerEntry = {
      id: ids.id,
      requestId: envelope.requestId,
      taskId: ids.taskId,
      executionId: ids.executionId,
      transcript: envelope.transcript,
      intent,
      plan,
      agentProviderId: intent?.label ?? null,
      steps: stepResults,
      verification: { passed: status === 'completed', detail: summary },
      retries,
      errors,
      latencyMs,
      status,
      startedAt,
      completedAt: Date.now(),
      summary,
    };
    this.ledger.save(entry);

    // Memory update: record the interaction and tool knowledge.
    if (status === 'completed') {
      void this.memory.recordInteraction(envelope.transcript, summary);
    }

    this.emit('completed', entry);
    return { entry, status, summary, payloads, reusedTool };
  }

  /**
   * Autonomous argument derivation. Fills sensible defaults for a step's tool
   * from the request so NOVA does not make the user pick a target. For
   * directory-analysis tools it resolves a real directory from the request or
   * a standard user folder.
   */
  private deriveArgs(tool: StepResult['tool'], step: StepResult['step'], request: string): Record<string, unknown> {
    const args = { ...step.args };
    const hay = `${tool?.category ?? ''} ${(tool?.capabilities ?? []).join(' ')} ${tool?.description ?? ''}`;
    if (/directory|folder|files|analysis/i.test(hay) && !args.directory && !args.path) {
      const q = String(args.query ?? request ?? '');
      const toks = q.split(/[\s,;]+/).filter(Boolean);
      const abs = toks.find(t => t.startsWith('/') || /^[A-Za-z]:[\\/]/.test(t));
      if (abs) {
        args.directory = abs;
      } else {
        const lower = q.toLowerCase();
        let dir: string | null = null;
        if (lower.includes('downloads')) dir = join(homedir(), 'Downloads');
        else if (lower.includes('documents')) dir = join(homedir(), 'Documents');
        else if (lower.includes('desktop')) dir = join(homedir(), 'Desktop');
        // Resolve to an EXISTING directory: home folder, then cwd, then data dir.
        if (dir) {
          if (!this.dirExists(dir)) dir = join(process.cwd(), 'Downloads');
        }
        if (!dir || !this.dirExists(dir)) dir = Nova2Config.paths.userData;
        if (!this.dirExists(dir)) dir = process.cwd();
        args.directory = dir;
      }
    }
    return args;
  }

  private dirExists(p: string): boolean {
    try {
      return statSync(p).isDirectory();
    } catch {
      return false;
    }
  }

  private async executeStep(envelope: RequestEnvelope, step: StepResult['step'], memory: unknown[]): Promise<StepResult> {
    let attempts = 0;
    let lastError: string | null = null;
    let lastPayload: unknown = null;
    let lastTool = null;

    while (attempts < 4) {
      attempts += 1;
      try {
        // Find or forge the required capability.
        let tool = null;
        if (step.tool) {
          tool = this.library.get(step.tool) ?? this.library.getByTechnicalId(step.tool) ?? this.library.getByName(step.tool);
        }
        if (!tool) {
          const discovery = this.discovery.discover(step.capability ?? envelope.transcript);
          if (discovery.found && discovery.best) {
            tool = this.library.get(discovery.best.toolId) ?? null;
          }
        }
        if (!tool) {
          // Forge a missing capability.
          this.stateMachine.transition('FORGING');
          this.emit('activity', { level: 'info', message: `Forging capability: ${step.capability ?? envelope.transcript}` });
          const tForge = Date.now();
          const forged = await this.forge.forge(step.capability ?? envelope.transcript, {});
          this.telemetry.record('forge', Date.now() - tForge, true);
          tool = forged.reused ? this.library.getByTechnicalId(forged.tool.technicalId) : forged.tool;
          lastPayload = null;
        }
        if (!tool) throw new Error('unable to obtain a capability for this step');
        lastTool = tool;

        this.stateMachine.transition('EXECUTING');
        const tTool = Date.now();
        const args = this.deriveArgs(tool, step, envelope.transcript);
        const execution = await this.executor.executeTool(tool, args);
        this.telemetry.record('tool', Date.now() - tTool, execution.success);
        lastPayload = execution.payload;
        if (!execution.success) throw new Error(execution.error ?? 'tool execution failed');

        // Independent verification.
        this.stateMachine.transition('VERIFYING');
        const tVerify = Date.now();
        const outcome = await this.verification.verify(execution.payload, step.verification, tool.category, envelope.transcript);
        this.telemetry.record('verification', Date.now() - tVerify, outcome.passed);
        if (!outcome.passed) {
          this.stateMachine.transition('RECOVERING');
          const report = this.recovery.toReport(new Error(outcome.detail), attempts);
          const decision = this.recovery.decide(report);
          this.recovery.log(report, decision);
          throw new Error(outcome.detail);
        }

        return {
          step,
          tool,
          success: true,
          payload: execution.payload,
          error: null,
          attempts,
          verification: outcome,
        };
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        const report = this.recovery.toReport(err, attempts);
        const decision = this.recovery.decide(report);
        this.recovery.log(report, decision);
        if (decision.action === 'replan' || decision.action === 'create_tool' || decision.action === 'repair_tool') {
          if (attempts >= 4) break;
          // On next iteration with a repair intent, clear tool so it re-forges.
          step.tool = null;
        }
      }
    }

    return {
      step,
      tool: lastTool,
      success: false,
      payload: lastPayload,
      error: lastError,
      attempts,
      verification: { passed: false, detail: lastError ?? 'step failed' },
    };
  }

  private buildSummary(status: TaskStatus, steps: StepResult[], label?: string): string {
    const verified = steps.filter(s => s.success && s.verification.passed).length;
    if (status === 'completed' && verified > 0) {
      return `Completed the requested objective${label ? ` (${label})` : ''} — ${verified} verified execution step${verified === 1 ? '' : 's'}.`;
    }
    if (verified > 0) return `Partially completed — ${verified} step${verified === 1 ? '' : 's'} verified, others failed.`;
    return 'The objective could not be completed. NOVA exhausted its available strategies without fabricating success.';
  }
}
