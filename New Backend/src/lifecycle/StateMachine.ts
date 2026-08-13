// New Backend — lifecycle/StateMachine.ts
// Backend state machine (System 47). A.D.A.M. transitions through explicit
// states that are surfaced to the existing frontend through the current IPC
// (no visual redesign). Strict transitions keep the system observably honest.
import { EventEmitter } from 'node:events';

export type AdamState =
  | 'IDLE'
  | 'LISTENING'
  | 'UNDERSTANDING'
  | 'PLANNING'
  | 'SELECTING_AGENT'
  | 'SELECTING_TOOL'
  | 'FORGING'
  | 'VALIDATING'
  | 'SANDBOXING'
  | 'EXECUTING'
  | 'VERIFYING'
  | 'RECOVERING'
  | 'SPEAKING'
  | 'MAINTAINING'
  | 'UPGRADING'
  | 'ERROR'
  | 'READY'
  | 'OFFLINE'
  | 'SHUTTING_DOWN';

export class StateMachine extends EventEmitter {
  private _state: AdamState = 'OFFLINE';

  get state(): AdamState {
    return this._state;
  }

  transition(next: AdamState): AdamState {
    const prev = this._state;
    if (prev === next) return next;
    this._state = next;
    this.emit('change', { from: prev, to: next, ts: Date.now() });
    return next;
  }

  /** Reset to IDLE (used after each task completes). */
  resetToIdle(): void {
    this.transition('IDLE');
  }

  isBusy(): boolean {
    return !['IDLE', 'READY', 'OFFLINE'].includes(this._state);
  }
}
