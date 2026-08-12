// New Backend — lifecycle/LifecycleEngine.ts
// Lifecycle Engine. Owns the deterministic startup and shutdown order so NOVA
// never claims READY prematurely and never leaves zombie workers/orphans on
// exit.
import { EventEmitter } from 'node:events';
import { logger } from '../core/logger.js';

export interface BootStep {
  stepId: string;
  label: string;
  status: 'pending' | 'active' | 'completed' | 'failed';
  timestamp: number;
}

export class LifecycleEngine extends EventEmitter {
  private steps: BootStep[] = [];
  private booted = false;
  private shuttingDown = false;

  private defineSteps(): void {
    this.steps = [
      { stepId: '1', label: 'Configuration + Secret Store', status: 'pending', timestamp: 0 },
      { stepId: '2', label: 'Python Runtime Probe', status: 'pending', timestamp: 0 },
      { stepId: '3', label: 'Tool Library Hydration + Health', status: 'pending', timestamp: 0 },
      { stepId: '4', label: 'Memory Engine', status: 'pending', timestamp: 0 },
      { stepId: '5', label: 'Environment Engine', status: 'pending', timestamp: 0 },
      { stepId: '6', label: 'Provider Initialization', status: 'pending', timestamp: 0 },
      { stepId: '7', label: 'Voice Engine', status: 'pending', timestamp: 0 },
      { stepId: '8', label: 'Capability Index', status: 'pending', timestamp: 0 },
      { stepId: '9', label: 'Orchestrator', status: 'pending', timestamp: 0 },
    ];
  }

  getSteps(): BootStep[] {
    return [...this.steps];
  }

  isBooted(): boolean {
    return this.booted;
  }

  isShuttingDown(): boolean {
    return this.shuttingDown;
  }

  /** Run the full startup sequence, marking each step. Returns true when READY. */
  async startup(actions: Record<string, () => Promise<void> | void>): Promise<boolean> {
    this.defineSteps();
    let ok = true;
    for (const step of this.steps) {
      step.status = 'active';
      step.timestamp = Date.now();
      this.emit('step', this.getSteps());
      try {
        const key = this.actionKey(step.label);
        if (actions[key]) await actions[key]();
        step.status = 'completed';
        step.timestamp = Date.now();
        this.emit('step', this.getSteps());
      } catch (err) {
        step.status = 'failed';
        step.timestamp = Date.now();
        logger.error(`[lifecycle] boot step failed: ${step.label}`, { error: String(err) });
        this.emit('step', this.getSteps());
        ok = false;
        break;
      }
    }
    this.booted = ok;
    if (ok) this.emit('ready');
    else this.emit('error');
    return ok;
  }

  private actionKey(label: string): string {
    if (label.includes('Config')) return 'config';
    if (label.includes('Python')) return 'python';
    if (label.includes('Tool Library')) return 'tools';
    if (label.includes('Memory')) return 'memory';
    if (label.includes('Environment')) return 'environment';
    if (label.includes('Provider')) return 'providers';
    if (label.includes('Voice')) return 'voice';
    if (label.includes('Capability')) return 'capability';
    if (label.includes('Orchestrator')) return 'orchestrator';
    return label;
  }

  /** Graceful shutdown in the reverse order of responsibility. */
  async shutdown(actions: Record<string, () => Promise<void> | void>): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    this.emit('shutdown-start');
    const order = ['orchestrator', 'capability', 'voice', 'providers', 'environment', 'memory', 'tools', 'python', 'config'];
    for (const key of order) {
      try {
        if (actions[key]) await actions[key]();
      } catch (err) {
        logger.warn(`[lifecycle] shutdown step ${key} failed`, { error: String(err) });
      }
    }
    this.booted = false;
    this.emit('shutdown-complete');
  }
}
