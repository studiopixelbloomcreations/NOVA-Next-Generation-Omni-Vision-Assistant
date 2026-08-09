// NOVA Task Runner — autonomous execution facade.
// The heavy lifting lives in autonomous_execution_engine.ts. Keeping this
// facade preserves the existing orchestrator/test API while replacing the
// old pattern-only planner with capability discovery + AI planning + Forge
// creation + production execution + verification + bounded recovery.
import { EventEmitter } from 'events';
import { ToolExecutor } from './tool_executor';
import { ToolRegistry } from './tool_registry';
import { AutonomousExecutionEngine, AgentPlanStep, EngineStepResult } from './autonomous_execution_engine';

export type TaskStatus = 'completed' | 'partial' | 'failed';

export interface TaskStep {
  stepId: string;
  label: string;
  tool: string;
  args: Record<string, unknown>;
  verify?: (payload: unknown) => { passed: boolean; detail: string };
  attempts: number;
  status: 'pending' | 'active' | 'completed' | 'failed' | 'recovered';
  result?: unknown;
  error?: string;
}

export interface TaskTrace {
  taskId: string;
  request: string;
  status: TaskStatus;
  steps: TaskStep[];
  toolsUsed: string[];
  startTime: number;
  endTime: number;
  summary: string;
  plan?: { objective: string; steps: AgentPlanStep[] };
  results?: EngineStepResult[];
}

export class TaskRunner extends EventEmitter {
  private readonly engine: AutonomousExecutionEngine;

  constructor(executor: ToolExecutor, registry: ToolRegistry) {
    super();
    this.engine = new AutonomousExecutionEngine(registry, executor);
    this.engine.on('progress', event => this.emit('progress', event));
    this.engine.on('completed', trace => this.emit('completed', trace));
  }

  /** Execute a natural-language request against the real machine. */
  public async runTask(request: string): Promise<TaskTrace> {
    const trace = await this.engine.run(request);
    return {
      taskId: trace.taskId,
      request: trace.request,
      status: trace.status,
      steps: trace.results.map(r => ({
        stepId: r.step.id,
        label: r.step.goal,
        tool: r.tool?.name ?? r.step.tool ?? 'unresolved',
        args: r.step.args,
        attempts: r.attempts,
        status: r.success ? 'completed' : 'failed',
        result: r.payload,
        error: r.error ?? undefined,
        verify: () => r.verification,
      })),
      toolsUsed: trace.results.map(r => r.tool?.name).filter((v): v is string => Boolean(v)),
      startTime: trace.startedAt,
      endTime: trace.completedAt,
      summary: trace.summary,
      plan: trace.plan,
      results: trace.results,
    };
  }

  /** Capability metadata for diagnostics and future UI use. */
  public listCapabilities(): Array<{ id: string; label: string; description: string }> {
    return [
      { id: 'autonomous_execution', label: 'Autonomous execution', description: 'Plans, executes, verifies and recovers from real computer tasks.' },
      { id: 'tool_discovery', label: 'Tool discovery', description: 'Searches all registered capabilities before creating new ones.' },
      { id: 'tool_forge', label: 'Python Tool Forge', description: 'Creates real Python tools, tests them in isolation, registers them and executes them on the host.' },
      { id: 'verification', label: 'Execution verification', description: 'Checks tool output and uses an AI verifier when available; never claims success from a model statement alone.' },
      { id: 'recovery', label: 'Bounded recovery', description: 'Retries failed actions with the same capability path without asking the user to debug the system.' },
    ];
  }
}
