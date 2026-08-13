// New Backend — upgrades/TrialManager.ts
// Upgrade Trial Manager (Systems 22/23). When a validated upgrade is ready,
// the user may choose to TRY it. During the trial, this manager monitors the
// health engine; if the backend degrades, it performs AUTOMATIC ROLLBACK. It
// never silently replaces production — a trial is explicit and observable.
import { EventEmitter } from 'node:events';
import type { UpgradeProposal } from './UpgradeEngine.js';
import { UpgradeEngine } from './UpgradeEngine.js';
import { HealthEngine, type HealthReport } from '../maintenance/HealthEngine.js';
import { logger } from '../core/logger.js';

export type TrialState = 'idle' | 'trial' | 'accepted' | 'rolled_back';

export interface TrialConfig {
  /** Health level at or below which the trial auto-rolls back. */
  rollbackThreshold: 'warning' | 'critical' | 'offline';
  maxTrialMs: number;
  healthCheckMs: number;
}

export class TrialManager extends EventEmitter {
  private state: TrialState = 'idle';
  private current: UpgradeProposal | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private trialStartedAt = 0;

  constructor(
    private readonly upgrades: UpgradeEngine,
    private readonly health: HealthEngine,
    private readonly config: TrialConfig = { rollbackThreshold: 'warning', maxTrialMs: 120_000, healthCheckMs: 5000 },
  ) {
    super();
  }

  get trialState(): TrialState {
    return this.state;
  }

  /** Begin an explicit trial of a ready upgrade. Returns false if not ready. */
  startTrial(id: string): boolean {
    if (this.state === 'trial') return false;
    const p = this.upgrades.startTrial(id);
    if (!p) return false;
    this.current = p;
    this.state = 'trial';
    this.trialStartedAt = Date.now();
    this.timer = setInterval(() => void this.checkHealth(), this.config.healthCheckMs);
    this.timer.unref?.();
    this.emit('trial-start', p);
    return true;
  }

  /** The user chose to keep the trialed upgrade. */
  accept(): void {
    if (this.current) this.upgrades.accept(this.current.id);
    this.stopMonitor();
    this.state = 'accepted';
    this.emit('trial-accepted', this.current);
  }

  /** Keep current — end trial without accepting. */
  keepCurrent(): void {
    this.stopMonitor();
    this.state = 'idle';
    this.current = null;
    this.emit('trial-kept');
  }

  private async checkHealth(): Promise<void> {
    if (this.state !== 'trial') return;
    if (Date.now() - this.trialStartedAt > this.config.maxTrialMs) {
      this.accept();
      return;
    }
    const report: HealthReport = await this.health.check();
    const threshold = { warning: 2, critical: 3, offline: 4 }[this.config.rollbackThreshold];
    const rank = (l: string): number => ({ healthy: 0, degraded: 1, warning: 2, critical: 3, offline: 4 }[l] ?? 0);
    if (rank(report.overall) >= threshold) {
      this.autoRollback();
    }
  }

  private autoRollback(): void {
    if (this.current) this.upgrades.rollback(this.current.id);
    this.stopMonitor();
    this.state = 'rolled_back';
    this.emit('trial-rolled-back', this.current);
    logger.warn('[trial_manager] automatic rollback triggered');
  }

  private stopMonitor(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Cancel an active trial (e.g. app shutting down). */
  abort(): void {
    if (this.state === 'trial' && this.current) this.upgrades.rollback(this.current.id);
    this.stopMonitor();
    this.state = 'idle';
    this.current = null;
  }
}
