// A.D.A.M. — additive Learning Engine.
// Merged into the restored legacy backend as an ADDITIVE capability. Records
// successful/failed strategies and tool/model performance, and recalls relevant
// lessons on future requests. Consumes the legacy memory engine for storage.
import type { MemoryEngine } from '../services/memory_engine';

export class AdamLearningEngine {
  constructor(private readonly memory: MemoryEngine) {}

  /** Record a lesson from a completed/failed task outcome. */
  learnFromOutcome(input: string, success: boolean, tools: string[], error?: string): void {
    if (success) {
      void this.memory.recordToolExecution(tools.join(',') || 'unknown', true, `Successful workflow: ${input.slice(0, 120)}`);
    } else {
      void this.memory.recordToolExecution(tools.join(',') || 'unknown', false, `Failed approach: ${input.slice(0, 100)} :: ${(error ?? '').slice(0, 200)}`);
    }
  }

  /** Retrieve relevant lessons (delegates to the legacy memory engine's search). */
  async recall(request: string, k = 5): Promise<unknown[]> {
    return this.memory.search(request, k);
  }
}
