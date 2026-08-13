// New Backend — maintenance/ErrorObservabilityEngine.ts
// Error Observability Engine (System 25). Every significant failure becomes a
// structured ErrorRecord and is fed to Maintenance, Recovery, Memory and
// Telemetry. This is the single place failures are captured with full context.
import { randomUUID } from 'node:crypto';
import { classifyFailure } from '../core/errors.js';
import type { FailureClass } from '../contracts/domain.js';
import { JsonFileStorage } from '../persistence/storage.js';

export interface ErrorRecord {
  errorId: string;
  timestamp: number;
  subsystem: string;
  severity: 'info' | 'warning' | 'critical';
  type: FailureClass;
  message: string;
  stack?: string;
  requestId?: string;
  taskId?: string;
  toolId?: string;
  model?: string;
  environment: string;
  resolution?: string;
}

export interface ErrorCapture {
  subsystem: string;
  message: string;
  severity?: ErrorRecord['severity'];
  stack?: string;
  requestId?: string;
  taskId?: string;
  toolId?: string;
  model?: string;
}

export class ErrorObservabilityEngine {
  private storage: JsonFileStorage;
  private recent: ErrorRecord[] = [];

  constructor(userData: string) {
    this.storage = new JsonFileStorage(userData, 'error_ledger');
    const loaded = this.storage.get<ErrorRecord[]>('errors');
    this.recent = Array.isArray(loaded) ? loaded : [];
  }

  capture(input: ErrorCapture, err?: unknown): ErrorRecord {
    const record: ErrorRecord = {
      errorId: randomUUID(),
      timestamp: Date.now(),
      subsystem: input.subsystem,
      severity: input.severity ?? (err ? 'critical' : 'warning'),
      type: classifyFailure(err ?? input.message),
      message: input.message.slice(0, 1000),
      stack: input.stack,
      requestId: input.requestId,
      taskId: input.taskId,
      toolId: input.toolId,
      model: input.model,
      environment: process.platform,
      resolution: undefined,
    };
    this.recent.unshift(record);
    if (this.recent.length > 500) this.recent.length = 500;
    this.persist();
    return record;
  }

  markResolved(errorId: string, resolution: string): void {
    const rec = this.recent.find(r => r.errorId === errorId);
    if (rec) {
      rec.resolution = resolution;
      this.persist();
    }
  }

  all(): ErrorRecord[] {
    return [...this.recent];
  }

  recentBySubsystem(subsystem: string, limit = 20): ErrorRecord[] {
    return this.recent.filter(r => r.subsystem === subsystem).slice(0, Math.max(1, limit));
  }

  countSince(ms: number, subsystem?: string): number {
    const cutoff = Date.now() - ms;
    return this.recent.filter(r => r.timestamp >= cutoff && (!subsystem || r.subsystem === subsystem)).length;
  }

  private persist(): void {
    this.storage.set('errors', this.recent);
    this.storage.flush();
  }

  flush(): void {
    this.storage.flush();
  }

  close(): void {
    this.storage.close();
  }
}
