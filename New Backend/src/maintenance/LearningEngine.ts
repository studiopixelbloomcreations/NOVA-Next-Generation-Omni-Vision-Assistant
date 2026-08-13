// New Backend — maintenance/LearningEngine.ts
// Learning Engine (System 26). A.D.A.M. learns from successful and failed
// tasks, tool performance and model performance, and surfaces that knowledge
// on future requests. It never blindly replays stale workflows — it returns
// ranked, relevant lessons that the orchestrator may consult.
import type { ExecutionLedgerEntry, MemoryEntry } from '../contracts/domain.js';
import { MemoryEngine } from '../memory/MemoryEngine.js';

export interface Lesson {
  kind: 'success_strategy' | 'failed_approach' | 'tool_performance' | 'model_performance' | 'workflow';
  summary: string;
  timestamp: number;
}

export class LearningEngine {
  constructor(private readonly memory: MemoryEngine) {}

  /** Record a lesson from a completed/failed task. */
  learnFromTask(entry: ExecutionLedgerEntry): void {
    if (entry.status === 'completed' && entry.steps.length > 0) {
      const tools = [...new Set(entry.steps.filter(s => s.tool).map(s => s.tool!.displayName))];
      this.memory.add(
        'workflow',
        `Successful workflow: "${entry.transcript.slice(0, 120)}" used tools: ${tools.join(', ')}.`,
        ['success', ...tools.map(t => t.toLowerCase())],
        'learning',
      );
    } else if (entry.status === 'failed') {
      this.memory.add(
        'fact',
        `Failed approach for "${entry.transcript.slice(0, 100)}": ${(entry.errors[entry.errors.length - 1] ?? 'unknown').slice(0, 200)}`,
        ['failed'],
        'learning',
      );
    }
  }

  /** Retrieve relevant lessons for a new request (ranked by the memory engine). */
  async recall(request: string, k = 5): Promise<MemoryEntry[]> {
    const results = await this.memory.search(request, k);
    return results.filter(m => m.tags.includes('success') || m.tags.includes('failed') || m.kind === 'workflow' || m.source === 'learning');
  }
}
