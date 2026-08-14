// A.D.A.M. — additive Continuous Maintenance Engine.
// Merged into the restored legacy backend as an ADDITIVE capability. Runs
// silently on a light interval, produces MaintenanceFinding[] from health and
// error signals, and NEVER makes uncontrolled production changes.
import { EventEmitter } from 'events';
import type { AdamHealthEngine, HealthLevel } from './health_engine';
import type { AdamErrorObservabilityEngine } from './error_observability';

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

export class AdamMaintenanceEngine extends EventEmitter {
  private findings: MaintenanceFinding[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private active = false;
  private suppressed = false;

  constructor(
    private readonly health: AdamHealthEngine,
    private readonly errors: AdamErrorObservabilityEngine,
    private readonly checkIntervalMs = 15000,
  ) {
    super();
  }

  start(): void {
    if (this.active) return;
    this.active = true;
    void this.runCheck(true);
    this.timer = setInterval(() => void this.runCheck(), this.checkIntervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    this.active = false;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  isActive(): boolean {
    return this.active;
  }

  /** Pause maintenance during critical user operations. */
  pause(): void { this.suppressed = true; }
  resume(): void { this.suppressed = false; }

  async runCheck(force = false): Promise<MaintenanceFinding[]> {
    if (this.suppressed && !force) return [];
    const report = await this.health.check();
    const batch: MaintenanceFinding[] = [];
    for (const sub of report.subsystems) {
      if (this.levelRank(sub.level) >= this.levelRank('warning')) {
        batch.push(this.makeFinding(sub.level as FindingSeverity, sub.subsystem, `${sub.subsystem} is ${sub.level}`, sub.detail));
      }
    }
    const recentErrors = this.errors.countSince(60_000);
    if (recentErrors > 0) {
      batch.push(this.makeFinding(recentErrors >= 5 ? 'critical' : 'warning', 'errors', `${recentErrors} error(s) in last 60s`, 'See error ledger.'));
    }
    for (const f of batch) {
      if (!this.findings.some(existing => existing.title === f.title && existing.resolved === false)) {
        this.findings.push(f);
        this.emit('finding', f);
      }
    }
    return batch;
  }

  findingsList(): MaintenanceFinding[] {
    return [...this.findings];
  }

  markResolved(id: string): boolean {
    const f = this.findings.find(x => x.id === id);
    if (f) { f.resolved = true; this.emit('resolved', f); return true; }
    return false;
  }

  private makeFinding(severity: FindingSeverity, subsystem: string, title: string, detail: string): MaintenanceFinding {
    return { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, severity, subsystem, title, detail, discoveredAt: Date.now(), resolved: false };
  }

  private levelRank(l: HealthLevel): number {
    return ({ healthy: 0, degraded: 1, warning: 2, critical: 3, offline: 4 } as Record<HealthLevel, number>)[l];
  }
}
