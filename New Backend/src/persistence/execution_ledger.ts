// New Backend — persistence/execution_ledger.ts
// The Execution Ledger. Every request records a full trace
// (requestId/taskId/executionId, plan, agent, steps, verification, retries,
// latency, final state). The ledger is also the duplicate-prevention barrier:
// the same requestId can never be executed twice.
import { randomUUID } from 'node:crypto';
import type { ExecutionLedgerEntry } from '../contracts/domain.js';
import { JsonFileStorage, RecordCollection } from './storage.js';
import { logger } from '../core/logger.js';

export class ExecutionLedger {
  private collection: RecordCollection<ExecutionLedgerEntry>;
  private storage: JsonFileStorage;

  constructor(userData: string) {
    this.storage = new JsonFileStorage(userData, 'execution_ledger');
    this.collection = new RecordCollection<ExecutionLedgerEntry>(this.storage, 'entries');
  }

  /**
   * Returns true when this requestId has already been executed (prevents
   * Gemini + Whisper double-execution of the same intent).
   */
  isExecuted(requestId: string): boolean {
    return this.all().some(e => e.requestId === requestId && e.status !== 'cancelled');
  }

  openEntry(transcript: string): Pick<ExecutionLedgerEntry, 'id' | 'requestId' | 'taskId' | 'executionId' | 'startedAt'> {
    const executionId = randomUUID();
    return {
      id: executionId,
      requestId: randomUUID(),
      taskId: randomUUID(),
      executionId,
      startedAt: Date.now(),
    };
  }

  save(entry: ExecutionLedgerEntry): void {
    this.collection.upsert(entry);
    this.flush();
  }

  all(): ExecutionLedgerEntry[] {
    return this.collection.all().sort((a, b) => b.startedAt - a.startedAt);
  }

  recent(limit = 50): ExecutionLedgerEntry[] {
    return this.all().slice(0, Math.max(1, limit));
  }

  /** Latency/success summary for telemetry + diagnostics. */
  summary(): { total: number; completed: number; partial: number; failed: number; avgLatencyMs: number } {
    const all = this.all();
    const total = all.length;
    if (total === 0) return { total: 0, completed: 0, partial: 0, failed: 0, avgLatencyMs: 0 };
    const sum = all.reduce((acc, e) => acc + e.latencyMs, 0);
    return {
      total,
      completed: all.filter(e => e.status === 'completed').length,
      partial: all.filter(e => e.status === 'partial').length,
      failed: all.filter(e => e.status === 'failed').length,
      avgLatencyMs: Math.round(sum / total),
    };
  }

  flush(): void {
    this.storage.flush();
  }

  close(): void {
    this.storage.close();
  }
}
