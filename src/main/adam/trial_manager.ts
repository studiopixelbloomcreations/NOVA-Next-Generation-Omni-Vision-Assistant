// A.D.A.M. — additive Upgrade Trial Manager with automatic rollback.
// Merged into the restored legacy backend as an ADDITIVE capability. During an
// explicit trial, monitors health; on degradation it performs AUTOMATIC
// rollback. Never silently replaces production.
import { EventEmitter } from 'events';
import type { AdamUpgradeEngine, UpgradeProposal } from './upgrade_engine';
import type { AdamHealthEngine, HealthReport } from './health_engine';

export type TrialState = 'idle' | 'trial' | 'accepted' | 'rolled_back';

export class AdamTrialManager extends EventEmitter {
  private state: TrialState = 'idle';
  private current: UpgradeProposal | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private startedAt = 0;

  constructor(
    private readonly upgrades: AdamUpgradeEngine,
    private readonly health: AdamHealthEngine,
    private readonly config: { rollbackThreshold: 'warning' | 'critical' | 'offline'; maxTrialMs: number; healthCheckMs: number } = { rollbackThreshold: 'warning', maxTrialMs: 120000, healthCheckMs: 5000 },
  ) {
    super();
  }

  get trialState(): TrialState { return this.state; }

  startTrial(id: string): boolean {
    if (this.state === 'trial') return false;
    const p = this.upgrades.startTrial(id);
    if (!p) return false;
    this.current = p;
    this.state = 'trial';
    this.startedAt = Date.now();
    this.timer = setInterval(() => void this.checkHealth(), this.config.healthCheckMs);
    this.timer.unref?.();
    this.emit('trial-start', p);
    return true;
  }

  accept(): void {
    if (this.current) this.upgrades.accept(this.current.id);
    this.stopMonitor();
    this.state = 'accepted';
    this.emit('trial-accepted', this.current);
  }

  keepCurrent(): void {
    this.stopMonitor();
    this.state = 'idle';
    this.current = null;
    this.emit('trial-kept');
  }

  private async checkHealth(): Promise<void> {
    if (this.state !== 'trial') return;
    if (Date.now() - this.startedAt > this.config.maxTrialMs) { this.accept(); return; }
    const report: HealthReport = await this.health.check();
    const threshold = ({ warning: 2, critical: 3, offline: 4 } as const)[this.config.rollbackThreshold];
    const rank = (l: string): number => ({ healthy: 0, degraded: 1, warning: 2, critical: 3, offline: 4 }[l] ?? 0);
    if (rank(report.overall) >= threshold) this.autoRollback();
  }

  private autoRollback(): void {
    if (this.current) this.upgrades.rollback(this.current.id);
    this.stopMonitor();
    this.state = 'rolled_back';
    this.emit('trial-rolled-back', this.current);
  }

  private stopMonitor(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  abort(): void {
    if (this.state === 'trial' && this.current) this.upgrades.rollback(this.current.id);
    this.stopMonitor();
    this.state = 'idle';
    this.current = null;
  }
}
