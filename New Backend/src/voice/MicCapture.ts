// New Backend — voice/MicCapture.ts
// MicCapture — owns the microphone capture lifecycle. In the Electron app the
// actual getUserMedia stream lives in the renderer (unchanged UI); the backend
// drives that via the existing MIC_TOGGLE/MIC_CAPTURE_ACTIVE IPC contract and
// receives PCM frames to feed the wake-word detector and Whisper transcriber.
// When running headless with a local audio backend (sounddevice) it can also
// capture directly through the Python runtime.
import { EventEmitter } from 'node:events';

export type MicState =
  | 'DISCONNECTED'
  | 'UNAVAILABLE'
  | 'PERMISSION_REQUIRED'
  | 'INITIALIZING'
  | 'READY'
  | 'LISTENING'
  | 'PAUSED'
  | 'ERROR'
  | 'STOPPING';

export interface MicSnapshot {
  state: MicState;
  available: boolean;
  listening: boolean;
  muted: boolean;
  defaultCapture: string | null;
  lastError: string | null;
}

export class MicCapture extends EventEmitter {
  private state: MicState = 'DISCONNECTED';
  private listening = false;
  private muted = false;
  private defaultCapture: string | null = null;
  private lastError: string | null = null;

  get snapshot(): MicSnapshot {
    return {
      state: this.state,
      available: this.state === 'READY' || this.state === 'LISTENING',
      listening: this.listening,
      muted: this.muted,
      defaultCapture: this.defaultCapture,
      lastError: this.lastError,
    };
  }

  /** Called by the Electron adapter when the renderer confirms capture state. */
  reportCaptureActive(active: boolean): void {
    if (active) {
      this.listening = true;
      this.state = 'LISTENING';
    } else {
      this.listening = false;
      this.state = this.muted ? 'PAUSED' : 'READY';
    }
    this.emit('change', this.snapshot);
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    this.emit('change', this.snapshot);
  }

  reportError(message: string): void {
    this.lastError = message;
    this.state = 'ERROR';
    this.emit('change', this.snapshot);
    this.emit('error', new Error(message));
  }

  markReady(defaultCapture: string | null): void {
    this.defaultCapture = defaultCapture ?? this.defaultCapture;
    if (this.state === 'DISCONNECTED' || this.state === 'UNAVAILABLE' || this.state === 'INITIALIZING') {
      this.state = 'READY';
    }
    this.emit('change', this.snapshot);
  }

  markUnavailable(reason: string): void {
    this.lastError = reason;
    this.state = 'UNAVAILABLE';
    this.emit('change', this.snapshot);
  }
}
