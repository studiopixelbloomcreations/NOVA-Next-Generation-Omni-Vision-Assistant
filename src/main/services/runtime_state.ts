// src/main/services/runtime_state.ts
// Authoritative runtime-state hub.
//
// The renderer must never guess its own status: every status chip, the
// bottom-left system indicator, the top-right state label, and the activity
// feed are all derived from this single source. All values here are measured
// from real subsystems — nothing is fabricated, and nothing falls back to a
// hardcoded "ONLINE". If a subsystem is down, its status says so, and the
// overall status reflects that honestly.
import { EventEmitter } from 'events';
import { logger } from '../core/logger';

export type SubsystemStatus =
  | 'starting'
  | 'online'
  | 'degraded'
  | 'offline'
  | 'unconfigured'
  | 'error';

export type OverallStatus = 'BOOTING' | 'ONLINE' | 'DEGRADED' | 'ERROR';

export interface IRuntimeStateSnapshot {
  /** When the main process started (epoch ms). */
  bootedAt: number;
  overall: OverallStatus;
  /** Per-subsystem truth. */
  electron: SubsystemStatus;
  python: SubsystemStatus;
  gemini: SubsystemStatus;
  groq: SubsystemStatus;
  memory: SubsystemStatus;
  toolRegistry: SubsystemStatus;
  toolExecutor: SubsystemStatus;
  microphone: SubsystemStatus;
  speaker: SubsystemStatus;
  /** Human-readable reasons per subsystem when not online. */
  details: Record<string, string>;
  /** What NOVA is doing right now (real, event-driven). */
  currentTask: string;
  lastError: string | null;
  uptimeMs: number;
  timestamp: number;
}

export interface IActivityEvent {
  id: string;
  ts: number;
  level: 'info' | 'success' | 'warn' | 'error';
  message: string;
}

const MAX_ACTIVITY = 200;
/** Broadcast bursts (boot steps, tool activity) are coalesced to one IPC
 * snapshot per window so the renderer is never flooded. */
const BROADCAST_DEBOUNCE_MS = 120;

/**
 * RuntimeState aggregates live subsystem status and an event activity feed.
 * Main process feeds it from real hooks (boot steps, provider connection
 * events, tool execution, python worker, memory) and broadcasts snapshots on
 * change; the renderer pulls the same snapshot over IPC.
 */
export class RuntimeState extends EventEmitter {
  private snap: IRuntimeStateSnapshot;
  private activity: IActivityEvent[] = [];
  private seq = 0;

  constructor() {
    super();
    this.snap = {
      bootedAt: Date.now(),
      overall: 'BOOTING',
      electron: 'starting',
      python: 'starting',
      gemini: 'starting',
      groq: 'starting',
      memory: 'starting',
      toolRegistry: 'starting',
      toolExecutor: 'starting',
      microphone: 'starting',
      speaker: 'starting',
      details: {},
      currentTask: 'Initializing NOVA runtime…',
      lastError: null,
      uptimeMs: 0,
      timestamp: Date.now(),
    };
  }

  /** Returns the current snapshot with uptime refreshed. */
  public snapshot(): IRuntimeStateSnapshot {
    return {
      ...this.snap,
      uptimeMs: Date.now() - this.snap.bootedAt,
      timestamp: Date.now(),
    };
  }

  /** Sets a subsystem status; broadcasts when the overall status changes. */
  public setSubsystem(
    key: keyof Omit<IRuntimeStateSnapshot, 'overall' | 'details' | 'currentTask' | 'lastError' | 'uptimeMs' | 'timestamp' | 'bootedAt'>,
    status: SubsystemStatus,
    reason = '',
  ): void {
    const prev = this.snap[key];
    if (prev === status && !reason) return;
    this.snap[key] = status;
    if (reason) {
      this.snap.details[key] = reason;
    } else {
      delete this.snap.details[key];
    }
    logger.info('[runtime_state] subsystem status', { subsystem: key, status, reason });
    this.maybeBroadcast();
  }

  /** Sets what NOVA is currently doing (real task state). */
  public setTask(task: string): void {
    if (this.snap.currentTask === task) return;
    this.snap.currentTask = task;
    // A task that moved forward clears a previous error: the UI must never
    // keep showing a stale failure after the system recovered.
    if (task !== 'Idle' && this.snap.lastError) this.snap.lastError = null;
    this.maybeBroadcast();
  }

  /** Records the last real error so the UI can show it instead of hiding it. */
  public setError(error: string | null): void {
    this.snap.lastError = error;
    this.maybeBroadcast();
  }

  /** Appends a real activity event to the feed and broadcasts. */
  public log(level: IActivityEvent['level'], message: string): void {
    const event: IActivityEvent = {
      id: `act_${Date.now().toString(36)}_${(this.seq++).toString(36)}`,
      ts: Date.now(),
      level,
      message,
    };
    this.activity.push(event);
    if (this.activity.length > MAX_ACTIVITY) {
      this.activity = this.activity.slice(this.activity.length - MAX_ACTIVITY);
    }
    logger.info('[runtime_state] activity', { level, message });
    this.emit('activity', event);
    this.maybeBroadcast();
  }

  public recentActivity(limit = 50): IActivityEvent[] {
    return this.activity.slice(-Math.min(Math.max(limit, 1), MAX_ACTIVITY)).reverse();
  }

  /**
   * Derives the honest overall status:
   *  - BOOTING until the electron core and its essentials leave 'starting';
   *  - ERROR when any critical subsystem is in error;
   *  - DEGRADED when a non-critical subsystem is down or unconfigured;
   *  - ONLINE only when everything that should be up is up.
   */
  private deriveOverall(): OverallStatus {
    const s = this.snap;
    const stillBooting =
      s.electron === 'starting' || s.gemini === 'starting' || s.memory === 'starting' || s.toolRegistry === 'starting';
    if (stillBooting) return 'BOOTING';
    if (s.electron === 'error' || s.memory === 'error' || s.toolRegistry === 'error' || s.toolExecutor === 'error') {
      return 'ERROR';
    }
    const critical = [s.gemini, s.electron, s.memory, s.toolRegistry, s.toolExecutor];
    if (critical.some(st => st === 'error' || st === 'offline')) return 'ERROR';
    const all = [s.gemini, s.python, s.groq, s.memory, s.toolRegistry, s.toolExecutor, s.microphone, s.speaker];
    if (all.some(st => st === 'offline' || st === 'unconfigured' || st === 'degraded')) return 'DEGRADED';
    return 'ONLINE';
  }

  private broadcastTimer: NodeJS.Timeout | null = null;

  private maybeBroadcast(): void {
    const overall = this.deriveOverall();
    if (overall !== this.snap.overall) {
      this.snap.overall = overall;
      logger.info('[runtime_state] overall status', { overall });
    }
    if (this.broadcastTimer) return;
    this.broadcastTimer = setTimeout(() => {
      this.broadcastTimer = null;
      this.emit('change', this.snapshot());
    }, BROADCAST_DEBOUNCE_MS);
  }
}

export const runtimeState = new RuntimeState();
