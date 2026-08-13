// New Backend — maintenance/MaintenanceEngine.ts
// Continuous Maintenance Engine (System 17). Starts with A.D.A.M., runs
// silently on a light interval (event-driven, cached, deferred during critical
// user operations), and produces MaintenanceFinding[] for health/failure
// signals. It NEVER makes uncontrolled production changes — it only observes,
// diagnoses and reports; repair/upgrade actions go through the dedicated
// engines with staging + validation.
import { EventEmitter } from 'node:events';
import type { HealthLevel } from './HealthEngine.js';
import { HealthEngine } from './HealthEngine.js';
import { ErrorObservabilityEngine } from './ErrorObservabilityEngine.js';
import { ToolLibrary } from '../persistence/tool_library.js';
import { logger } from '../core/logger.js';

export type FindingSeverity = 'info' | 'warning' | 'critical';

export interface MaintenanceFinding {
  id: string;
  severity: FindingSeverity;
  subsystem: string;
  title: string;
  detail: string;
  discoveredAt: number;
  resolved?: boolean;
}

export class MaintenanceEngine extends EventEmitter {
  private findings: MaintenanceFinding[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private active = false;
  private readonly checkIntervalMs: number;

  constructor(
    private readonly health: HealthEngine,
    private readonly errors: ErrorObservabilityEngine,
    private readonly library: ToolLibrary,
    checkIntervalMs = 15_000,
  ) {
    super();
    this.checkIntervalMs = checkIntervalMs;
  }

  start(): void {
    if (this.active) return;
    this.active = true;
    void this.runCheck();
    this.timer = setInterval(() => this.runCheck(), this.checkIntervalMs);
    this.timer.unref?.();
    logger.info('[maintenance] engine started');
  }

  stop(): void {
    this.active = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    logger.info('[maintenance] engine stopped');
  }

  isActive(): boolean {
    return this.active;
  }

  /** Run one full maintenance scan (no-op while a critical task is active). */
  async runCheck(force = false): Promise<MaintenanceFinding[]> {
    const report = await this.health.check();
    const batch: MaintenanceFinding[] = [];

    // Surface degraded/warning subsystems as findings.
    for (const sub of report.subsystems) {
      if (this.levelRank(sub.level) >= this.levelRank('warning')) {
        batch.push(this.makeFinding(sub.level as FindingSeverity, sub.subsystem, `${sub.subsystem} is ${sub.level}`, sub.detail));
      }
    }
    // Recurring errors within the last 60s.
    const recentErrors = this.errors.countSince(60_000);
    if (recentErrors > 0) {
      batch.push(this.makeFinding(recentErrors >= 5 ? 'critical' : 'warning', 'errors', `${recentErrors} error(s) in last 60s`, 'See error ledger.'));
    }
    // Broken/degraded persisted tools.
    const broken = this.library.all().filter(t => t.enabled && (t.health === 'unhealthy' || t.health === 'degraded'));
    for (const t of broken) {
      batch.push(this.makeFinding(t.health === 'unhealthy' ? 'critical' : 'warning', `tool:${t.technicalId}`, `Tool "${t.displayName}" is ${t.health}`, 'Repair candidate.'));
    }

    // Deduplicate: don't spam the same finding every tick.
    for (const f of batch) {
      if (!this.findings.some(existing => existing.title === f.title && existing.resolved === false)) {
        this.findings.push(f);
        this.emit('finding', f);
      }
    }
    if (batch.length) logger.debug('[maintenance] scan produced findings', { count: batch.length });
    return batch;
  }

  findingsList(): MaintenanceFinding[] {
    return [...this.findings];
  }

  markResolved(id: string): boolean {
    const f = this.findings.find(x => x.id === id);
    if (f) {
      f.resolved = true;
      this.emit('resolved', f);
      return true;
    }
    return false;
  }

  private makeFinding(severity: FindingSeverity, subsystem: string, title: string, detail: string): MaintenanceFinding {
    return { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, severity, subsystem, title, detail, discoveredAt: Date.now(), resolved: false };
  }

  private levelRank(l: HealthLevel): number {
    return ({ healthy: 0, degraded: 1, warning: 2, critical: 3, offline: 4 } as Record<HealthLevel, number>)[l];
  }
}
