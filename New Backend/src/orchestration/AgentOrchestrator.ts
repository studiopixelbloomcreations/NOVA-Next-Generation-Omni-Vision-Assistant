// New Backend — orchestration/AgentOrchestrator.ts
// Agent Orchestrator (Systems 13/14). For difficult tasks it can spin up
// short-lived, scoped, bounded, disposable specialist subagents (architecture,
// Python, security, provider, QA) that inspect independently; the orchestrator
// aggregates their findings and selects the best conclusions. Subagents are
// never uncontrolled or permanent — each is bounded, observable and discarded.
import { randomUUID } from 'node:crypto';
import type { AiProvider } from '../providers/ProviderTypes.js';
import { AgentSelector } from '../reasoning/AgentSelector.js';

export type SubagentRole = 'architecture' | 'python' | 'security' | 'provider' | 'qa';

export interface Subagent {
  id: string;
  role: SubagentRole;
  boundedToMs: number;
  startedAt: number;
  conclusion: string | null;
  done: boolean;
}

export class AgentOrchestrator {
  private active: Subagent[] = [];
  private readonly boundedMs: number;

  constructor(private readonly selector: AgentSelector, boundedMs = 12_000) {
    this.boundedMs = boundedMs;
  }

  /**
   * Run a scoped subagent that independently analyses the task and returns a
   * conclusion. Bounded by a hard timeout; always resolved (never hangs).
   */
  async runSubagent(role: SubagentRole, task: string, provider?: AiProvider | null): Promise<Subagent> {
    const id = randomUUID();
    const startedAt = Date.now();
    const sub: Subagent = { id, role, boundedToMs: this.boundedMs, startedAt, conclusion: null, done: false };
    this.active.push(sub);
    const agent = provider ?? this.selector.trySelect('reasoning');
    try {
      if (agent && agent.isConfigured()) {
        const prompt =
          `You are a ${role} specialist subagent inside A.D.A.M. Independently analyse the following task and ` +
          `return a concise, concrete conclusion (what is correct, what is risky, what should change).\n\n` +
          `TASK: ${task}\n\nReturn a short structured answer.`;
        const conclusion = await Promise.race([
          agent.generate(prompt, { timeoutMs: this.boundedMs, maxOutputTokens: 400 }),
          new Promise<string>(res => setTimeout(() => res('(subagent timed out — bounded)'), this.boundedMs)),
        ]);
        sub.conclusion = conclusion;
      } else {
        sub.conclusion = '(no reasoning provider available for subagent)';
      }
    } catch (err) {
      sub.conclusion = `(subagent error: ${err instanceof Error ? err.message : String(err)})`;
    } finally {
      sub.done = true;
      this.active = this.active.filter(a => a.id !== id);
    }
    return sub;
  }

  /** Aggregate conclusions from a set of subagents into a single summary. */
  aggregate(subagents: Subagent[]): string {
    const usable = subagents.filter(s => s.conclusion && !s.conclusion.startsWith('(subagent'));
    if (usable.length === 0) return subagents.map(s => s.conclusion ?? '(no conclusion)').join(' ');
    return usable.map(s => `[${s.role}] ${s.conclusion}`).join('\n');
  }

  activeSubagents(): Subagent[] {
    return [...this.active];
  }

  /** Disposal / cancellation of all active subagents. */
  disposeAll(): void {
    for (const s of this.active) {
      s.done = true;
      s.conclusion = '(subagent disposed)';
    }
    this.active = [];
  }
}
