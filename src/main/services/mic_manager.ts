// src/main/services/mic_manager.ts
// Authoritative microphone state manager.
//
// Single source of truth for microphone status in NOVA. Every value here is
// measured from the real system:
//   - device discovery runs through the Python audio service (WASAPI/PnP);
//   - capture availability is probed with a real local diagnostic;
//   - listening is toggled by the renderer's actual getUserMedia pipeline.
// There is no hardcoded "READY" — if the OS reports no capture endpoint, the
// state is UNAVAILABLE and the UI reflects it.
import { EventEmitter } from 'events';
import { logger } from '../core/logger';
import { pythonRuntime } from './python_runtime';
import { BrowserWindow } from 'electron';

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

export interface IAudioDeviceInfo {
  name: string;
  status: string;
  id: string;
  direction: string;
}

export interface IMicSnapshot {
  state: MicState;
  available: boolean;
  listening: boolean;
  muted: boolean;
  devices: IAudioDeviceInfo[];
  defaultCapture: string | null;
  lastError: string | null;
  lastDiagnostic: {
    ok: boolean;
    sampleRate?: number;
    frames?: number;
    rms?: number;
    peak?: number;
    hasSignal?: boolean;
    error?: string;
  } | null;
  timestamp: number;
}

export class MicManager extends EventEmitter {
  private state: MicState = 'DISCONNECTED';
  private available = false;
  private listening = false;
  private muted = false;
  private devices: IAudioDeviceInfo[] = [];
  private defaultCapture: string | null = null;
  private lastError: string | null = null;
  private lastDiagnostic: IMicSnapshot['lastDiagnostic'] = null;
  public snapshot(): IMicSnapshot {
    return {
      state: this.state,
      available: this.available,
      listening: this.listening,
      muted: this.muted,
      devices: this.devices,
      defaultCapture: this.defaultCapture,
      lastError: this.lastError,
      lastDiagnostic: this.lastDiagnostic,
      timestamp: Date.now(),
    };
  }

  public getState(): MicState {
    return this.state;
  }

  public isListening(): boolean {
    return this.listening;
  }

  /** Discovers real audio devices through the Python worker. */
  public async discover(): Promise<IAudioDeviceInfo[]> {
    this.setState('INITIALIZING');
    try {
      // Warm up the Python worker first (cold start + first PowerShell probe
      // can exceed 8s on a fresh boot).
      await pythonRuntime.status(true);
      const result = await pythonRuntime.request('audio.devices', {}, 20000);
      const data = (result.ok ? result.data : null) as
        | { inputs?: IAudioDeviceInfo[]; available?: boolean }
        | null;
      if (result.ok && data) {
        this.devices = (data.inputs ?? []).filter(d => d.direction === 'input');
        this.available = data.available === true && this.devices.length > 0;
        const micInfo = await pythonRuntime.request('audio.microphone_info', {}, 15000);
        const micData = (micInfo.ok ? micInfo.data : null) as {
          defaultCapture?: string | null;
        } | null;
        this.defaultCapture =
          (micData?.defaultCapture ?? null) || (this.devices[0]?.name ?? null);
        this.lastError = null;
        if (this.available) {
          this.setState('READY');
        } else {
          this.setState('UNAVAILABLE');
        }
        logger.info('[mic_manager] discovered', {
          count: this.devices.length,
          defaultCapture: this.defaultCapture,
        });
        return this.devices;
      }
      this.available = false;
      this.setState('UNAVAILABLE');
      this.lastError = result.error ?? 'audio discovery returned no devices';
      return [];
    } catch (err) {
      this.available = false;
      this.lastError = err instanceof Error ? err.message : String(err);
      this.setState('ERROR');
      logger.error('[mic_manager] discovery failed', { error: this.lastError });
      return [];
    }
  }

  /** Marks permission denied (renderer getUserMedia rejection). */
  public reportPermissionDenied(): void {
    this.available = false;
    this.setState('PERMISSION_REQUIRED');
    this.lastError = 'Microphone permission was denied — enable it in Windows privacy settings or the app permission prompt.';
  }

  /**
   * Runs a real local audio diagnostic through the Python runtime (WASAPI).
   * Records a short sample, computes RMS, releases the device. Never sends the
   * sample anywhere.
   */
  public async runDiagnostic(sampleMs = 500): Promise<IMicSnapshot['lastDiagnostic']> {
    try {
      await pythonRuntime.status(true);
      const result = await pythonRuntime.request('audio.diagnostic', { sample_ms: sampleMs }, 25000);
      const data = (result.ok ? result.data : null) as {
        ok?: boolean;
        sampleRate?: number;
        frames?: number;
        rms?: number;
        peak?: number;
        hasSignal?: boolean;
        error?: string;
      } | null;
      if (result.ok && data) {
        this.lastDiagnostic = data as IMicSnapshot['lastDiagnostic'];
        if (data.ok) {
          this.available = true;
          if (!this.listening) this.setState('READY');
        } else {
          this.lastError = data.error ?? 'diagnostic failed';
          this.setState('UNAVAILABLE');
        }
      } else {
        const errMsg = result.error ?? 'diagnostic failed';
        this.lastDiagnostic = { ok: false, error: errMsg };
        this.lastError = errMsg;
        this.setState('ERROR');
      }
      logger.info('[mic_manager] diagnostic', { ...this.lastDiagnostic });
      return this.lastDiagnostic;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.lastDiagnostic = { ok: false, error: errMsg };
      this.lastError = errMsg;
      this.setState('ERROR');
      return this.lastDiagnostic;
    }
  }

  /** Renderer-side capture is active (getUserMedia running + chunks flowing). */
  public reportListening(): void {
    this.listening = true;
    this.available = true;
    this.setState('LISTENING');
  }

  public reportStoppedListening(): void {
    this.listening = false;
    this.setState(this.available ? 'READY' : 'UNAVAILABLE');
  }

  public setMuted(muted: boolean): void {
    if (this.muted === muted) return;
    this.muted = muted;
    this.emit('change', this.snapshot());
    this.broadcast();
  }

  public reportError(error: string): void {
    this.lastError = error;
    this.setState('ERROR');
  }

  private setState(state: MicState): void {
    if (this.state === state && !this.lastError) return;
    this.state = state;
    logger.info('[mic_manager] state', { state });
    this.emit('change', this.snapshot());
    this.broadcast();
  }

  private broadcast(): void {
    try {
      // Unit tests and headless tools load this module without a real Electron
      // BrowserWindow implementation. State transitions must remain usable in
      // those environments and must never be reported as a mic failure.
      if (!BrowserWindow || typeof (BrowserWindow as any).getAllWindows !== 'function') return;
      const windows = BrowserWindow.getAllWindows();
      for (const win of windows) {
        if (!win.isDestroyed()) {
          win.webContents.send('nova-sys:mic-state-change', this.snapshot());
        }
      }
    } catch (err) {
      logger.error('[mic_manager] broadcast failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

export const micManager = new MicManager();
