// New Backend — planning/PlanningEngine.ts
// Planning Engine. Takes the user goal, intent, memory, environment snapshot,
// and available capabilities, and produces a machine-executable ExecutionPlan
// with steps, dependencies, required capabilities, expected results,
// verification strategy, fallback strategies, timeout, and risk level.
import type { AiProvider } from '../providers/ProviderTypes.js';
import type { ExecutionPlan, MemoryEntry, PlanStep, RequestEnvelope, StructuredIntent } from '../contracts/domain.js';
import { PromptEngine } from '../reasoning/PromptEngine.js';
import { CapabilityDiscoveryEngine } from '../capability/CapabilityDiscoveryEngine.js';
import { PlanEmptyError } from '../core/errors.js';
import { Nova2Config } from '../core/config.js';
import { logger } from '../core/logger.js';

export class PlanningEngine {
  private readonly prompts: PromptEngine;

  constructor(private readonly discovery: CapabilityDiscoveryEngine) {
    this.prompts = new PromptEngine();
  }

  /** Produce an ExecutionPlan. AI-assisted when a provider is available. */
  async plan(
    envelope: RequestEnvelope,
    intent: StructuredIntent,
    memory: MemoryEntry[],
    provider: AiProvider | null,
  ): Promise<ExecutionPlan> {
    const discovery = this.discovery.discover(envelope.transcript);
    if (provider && provider.isConfigured()) {
      try {
        const prompt = this.prompts.buildPlanPrompt(envelope.transcript, discovery.catalog, Nova2Config.execution.maxPlanSteps);
        const raw = await provider.generate(prompt, { timeoutMs: Nova2Config.execution.planTimeoutMs, maxOutputTokens: 2048 });
        const plan = this.parsePlan(raw, envelope.transcript);
        logger.debug('[planning] AI plan ready', { steps: plan.steps.length, goal: plan.goal });
        return plan;
      } catch (err) {
        logger.warn('[planning] AI planner failed; using deterministic plan', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Deterministic recovery planner.
    if (discovery.found && discovery.best) {
      return this.singleStepPlan(envelope.transcript, discovery.best.toolName, discovery.best.description, intent);
    }
    if (intent.needsToolCreation) {
      return this.singleStepPlan(envelope.transcript, null, envelope.transcript, intent, 'create');
    }
    // Generic single-step plan.
    return this.singleStepPlan(envelope.transcript, null, envelope.transcript, intent);
  }

  private singleStepPlan(goal: string, tool: string | null, capability: string, intent: StructuredIntent, mode?: string): ExecutionPlan {
    const timeoutMs = intent.kind === 'tool_creation' ? 60000 : Nova2Config.forge.productionTimeoutMs;
    const step: PlanStep = {
      id: '1',
      goal,
      capability,
      tool,
      args: { query: goal },
      verification: 'the requested operation completes successfully with a real, observable result',
      fallbackStrategies: ['retry', 'forge a missing capability', 'replan'],
      timeoutMs,
    };
    return {
      goal,
      steps: [step],
      dependencies: [],
      requiredCapabilities: mode === 'create' ? [capability] : tool ? [capability] : [],
      expectedResults: ['a structured result is returned and independently verified'],
      verificationStrategy: 'independent verifier then objective check',
      fallbackStrategies: ['retry', 'alternative tool', 'replan'],
      timeoutMs,
      riskLevel: intent.kind === 'tool_creation' || intent.kind === 'multi_step_task' ? 'medium' : 'low',
    };
  }

  private parsePlan(raw: string, fallbackGoal: string): ExecutionPlan {
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start < 0 || end <= start) throw new PlanEmptyError();
    const parsed = JSON.parse(cleaned.slice(start, end + 1)) as Partial<ExecutionPlan>;
    const rawSteps = Array.isArray(parsed.steps) ? parsed.steps : [];
    const steps: PlanStep[] = rawSteps.slice(0, Nova2Config.execution.maxPlanSteps).map((s, i) => ({
      id: String((s as PlanStep).id ?? i + 1),
      goal: String((s as PlanStep).goal ?? fallbackGoal),
      capability: String((s as PlanStep).capability ?? fallbackGoal),
      tool: (s as PlanStep).tool ? String((s as PlanStep).tool) : null,
      args: (s as PlanStep).args && typeof (s as PlanStep).args === 'object' ? (s as PlanStep).args : { query: fallbackGoal },
      verification: String((s as PlanStep).verification ?? 'the operation completes successfully'),
      fallbackStrategies: Array.isArray((s as PlanStep).fallbackStrategies) ? (s as PlanStep).fallbackStrategies.map(String) : ['retry', 'replan'],
      timeoutMs: Number((s as PlanStep).timeoutMs) || Nova2Config.forge.productionTimeoutMs,
    }));
    if (steps.length === 0) throw new PlanEmptyError();
    return {
      goal: String(parsed.goal ?? fallbackGoal),
      steps,
      dependencies: [],
      requiredCapabilities: steps.map(s => s.capability),
      expectedResults: steps.map(s => s.verification),
      verificationStrategy: 'per-step independent verifier',
      fallbackStrategies: ['retry', 'alternative tool', 'forge', 'replan'],
      timeoutMs: Nova2Config.execution.planTimeoutMs,
      riskLevel: steps.length > 3 ? 'medium' : 'low',
    };
  }
}
