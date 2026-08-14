// A.D.A.M. — additive Agent Orchestrator (bounded subagents).
// Merged into the restored legacy backend as an ADDITIVE capability. Spins up
// short-lived, scoped, bounded, disposable specialist subagents that inspect
// independently; the orchestrator aggregates conclusions.
import { randomUUID } from 'crypto';
import type { AiProvider } from '../services/ai_provider';

export type SubagentRole = 'architecture' | 'python' | 'security' | 'provider' | 'qa';

export interface Subagent {
  id: string;
  role: SubagentRole;
  boundedToMs: number;
  startedAt: number;
  conclusion: string | null;
  done: boolean;
}

export class AdamSubagentOrchestrator {
  private active: Subagent[] = [];

  constructor(
    private readonly providerSelect: () => AiProvider | null,
    private readonly boundedMs = 12000,
  ) {}

  async runSubagent(role: SubagentRole, task: string, provider?: AiProvider | null): Promise<Subagent> {
    const id = randomUUID();
    const startedAt = Date.now();
    const sub: Subagent = { id, role, boundedToMs: this.boundedMs, startedAt, conclusion: null, done: false };
    this.active.push(sub);
    const agent = provider ?? this.providerSelect();
    try {
      if (agent && agent.isConfigured()) {
        const prompt =
          `You are a ${role} specialist subagent inside A.D.A.M. Independently analyse the following task and ` +
          `return a concise, concrete conclusion (what is correct, what is risky, what should change).\n\n` +
          `TASK: ${task}\n\nReturn a short structured answer.`;
        sub.conclusion = await Promise.race([
          agent.generate(prompt, { timeoutMs: this.boundedMs, maxOutputTokens: 400 }),
          new Promise<string>(res => setTimeout(() => res('(subagent timed out — bounded)'), this.boundedMs)),
        ]);
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

  aggregate(subagents: Subagent[]): string {
    const usable = subagents.filter(s => s.conclusion && !s.conclusion.startsWith('(subagent'));
    if (usable.length === 0) return subagents.map(s => s.conclusion ?? '(no conclusion)').join(' ');
    return usable.map(s => `[${s.role}] ${s.conclusion}`).join('\n');
  }

  activeSubagents(): Subagent[] { return [...this.active]; }

  disposeAll(): void {
    for (const s of this.active) { s.done = true; s.conclusion = '(subagent disposed)'; }
    this.active = [];
  }
}
