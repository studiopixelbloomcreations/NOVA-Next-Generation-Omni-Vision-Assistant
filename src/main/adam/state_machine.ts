// A.D.A.M. — additive backend state machine.
// Merged into the restored legacy backend as an ADDITIVE capability. Tracks the
// explicit backend state (IDLE/LISTENING/UNDERSTANDING/PLANNING/FORGING/
// EXECUTING/VERIFYING/RECOVERING/MAINTAINING/UPGRADING/READY/OFFLINE/
// SHUTTING_DOWN) and emits change events the runtime state hub can reflect.
import { EventEmitter } from 'events';

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

export class AdamStateMachine extends EventEmitter {
  private _state: AdamState = 'OFFLINE';

  get state(): AdamState {
    return this._state;
  }

  transition(next: AdamState): AdamState {
    if (this._state === next) return next;
    const prev = this._state;
    this._state = next;
    this.emit('change', { from: prev, to: next, ts: Date.now() });
    return next;
  }

  resetToIdle(): void {
    this.transition('IDLE');
  }

  isBusy(): boolean {
    return !['IDLE', 'READY', 'OFFLINE'].includes(this._state);
  }
}
