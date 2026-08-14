// A.D.A.M. — additive Error Observability Engine.
// Merged into the restored legacy backend as an ADDITIVE capability. Every
// significant failure becomes a structured ErrorRecord fed to maintenance and
// telemetry. This is the single place failures are captured with context.
import { randomUUID } from 'crypto';
import type { FailureClass } from './types';

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

export class AdamErrorObservabilityEngine {
  private recent: ErrorRecord[] = [];

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
    return record;
  }

  markResolved(errorId: string, resolution: string): void {
    const rec = this.recent.find(r => r.errorId === errorId);
    if (rec) rec.resolution = resolution;
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
}

export function classifyFailure(err: unknown): FailureClass {
  const message = err instanceof Error ? err.message : String(err);
  const m = message.toLowerCase();
  if (m.includes('timeout') || m.includes('timed out')) return 'timeout';
  if (m.includes('permission') || m.includes('denied') || m.includes('not permitted')) return 'permission';
  if (m.includes('network') || m.includes('fetch') || m.includes('socket') || m.includes('api error')) return 'network_failure';
  if (m.includes('not configured') || m.includes('unavailable') || m.includes('api key')) return 'provider_unavailable';
  if (m.includes('module') || m.includes('import') || m.includes('dependency')) return 'dependency_error';
  if (m.includes('verif')) return 'verification_failure';
  if (m.includes('json') || m.includes('parse') || m.includes('malformed')) return 'malformed_output';
  return 'tool_error';
}
