// src/renderer/utils/audio_recorder.ts
// Renderer-side microphone capture.
//
// The renderer runs with `sandbox: true` + `contextIsolation: true`, so there
// is NO Node `Buffer` global and no `require`. Sending raw PCM therefore uses
// plain Uint8Array/ArrayBuffer over the preload bridge — a `Buffer.from(...)`
// call here used to throw `ReferenceError` on every frame, silently killing
// the entire voice pipeline while the UI still showed LISTENING (the amplitude
// callback ran before the crash). That was the "microphone is broken / I have
// to type" root cause.
const ipcRenderer = (() => {
  try {
    if (typeof window !== 'undefined' && (window as any).__nova_ipc__) {
      return (window as any).__nova_ipc__;
    }
    if (typeof window !== 'undefined' && (window as any).require) {
      return (window as any).require('electron').ipcRenderer;
    }
  } catch {
    return null;
  }
  return null;
})();

export interface IAudioDiagnosticResult {
  ok: boolean;
  frames?: number;
  rms?: number;
  peak?: number;
  sampleRate?: number;
  hasSignal?: boolean;
  error?: string;
}

/** Gemini Live expects 16 kHz mono Int16 PCM. */
const TARGET_SAMPLE_RATE = 16000;

/**
 * Linear-interpolation resampler from any source rate to 16 kHz. The browser
 * AudioContext often runs at the device rate (44.1/48 kHz) even when 16 kHz is
 * requested, so the PCM we send MUST match the rate we declare, otherwise the
 * transcript is garbage. This keeps `audio/pcm;rate=16000` honest.
 */
function resampleTo16k(input: Float32Array, inputRate: number): Float32Array {
  if (inputRate === TARGET_SAMPLE_RATE) return input;
  const ratio = inputRate / TARGET_SAMPLE_RATE;
  const outLen = Math.max(1, Math.floor(input.length / ratio));
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(i0 + 1, input.length - 1);
    const frac = pos - i0;
    out[i] = input[i0] + (input[i1] - input[i0]) * frac;
  }
  return out;
}

/** Float32 (-1..1) -> Int16 PCM. */
function toPcm16(float32: Float32Array): Int16Array {
  const pcm = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    const sample = Math.max(-1, Math.min(1, float32[i]));
    pcm[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  return pcm;
}

export class AudioRecorder {
  private audioCtx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private processor: ScriptProcessorNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private _isCapturing = false;
  private onAmplitudeCb: ((amp: number) => void) | null = null;
  private forwarding = true;

  /** Whether the getUserMedia capture is currently active. */
  public get isCapturing(): boolean {
    return this._isCapturing;
  }

  public async resumeAudio(): Promise<void> {
    try {
      if (!this.audioCtx) {
        this.audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)({
          sampleRate: TARGET_SAMPLE_RATE,
        });
      }
      if (this.audioCtx.state === 'suspended') {
        await this.audioCtx.resume();
      }
    } catch {
      console.warn('resumeAudio failed');
    }
  }

  /**
   * Opens the real microphone. When `forward` is true, PCM frames are sent to
   * the main process (Gemini Live). When false, frames are analysed locally
   * only — used by the diagnostic so it never transmits audio.
   */
  public async startRecording(
    onAmplitudeUpdate: (amp: number) => void,
    forward = true,
  ): Promise<void> {
    try {
      this.onAmplitudeCb = onAmplitudeUpdate;
      this.forwarding = forward;
      // Do NOT force `sampleRate` in getUserMedia constraints: devices that
      // only expose 44.1/48 kHz can throw OverconstrainedError, killing the
      // whole request. We request the AudioContext at 16 kHz and resample the
      // actual frames to 16 kHz ourselves, so the declared PCM rate is always
      // true regardless of what the OS/hardware delivers.
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });

      await this.resumeAudio();
      if (!this.audioCtx) {
        this.audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)({
          sampleRate: TARGET_SAMPLE_RATE,
        });
      }

      this.source = this.audioCtx.createMediaStreamSource(this.stream);

      this.processor = this.audioCtx.createScriptProcessor(512, 1, 1);

      this.source.connect(this.processor);
      this.processor.connect(this.audioCtx.destination);

      this._isCapturing = true;
      this.processor.onaudioprocess = e => {
        try {
          const inputData = e.inputBuffer.getChannelData(0);
          const actualRate = this.audioCtx?.sampleRate ?? TARGET_SAMPLE_RATE;

          let sum = 0;
          for (let i = 0; i < inputData.length; i++) {
            sum += inputData[i] * inputData[i];
          }
          const rms = Math.sqrt(sum / inputData.length);
          if (this.onAmplitudeCb) this.onAmplitudeCb(rms);

          if (!this.forwarding) return;

          // Resample to the declared 16 kHz rate, then convert to Int16 PCM.
          const resampled = resampleTo16k(inputData, actualRate);
          const pcm = toPcm16(resampled);

          if (ipcRenderer) {
            // Sandboxed renderer: send the raw Int16 buffer as a Uint8Array.
            // The main-process handler accepts Buffer OR Uint8Array.
            ipcRenderer.send('user-audio-chunk', new Uint8Array(pcm.buffer));
          }
        } catch (err) {
          console.error('Audio frame processing failed:', err);
        }
      };
    } catch (err) {
      console.error('Failed to initialize microphone hardware capture:', err);
      throw err;
    }
  }

  public stopRecording(): void {
    this._isCapturing = false;
    this.onAmplitudeCb = null;
    if (this.processor) {
      this.processor.onaudioprocess = null;
      this.processor.disconnect();
      this.processor = null;
    }
    if (this.source) {
      this.source.disconnect();
      this.source = null;
    }
    if (this.stream) {
      this.stream.getTracks().forEach(track => track.stop());
      this.stream = null;
    }
    if (this.audioCtx) {
      this.audioCtx.close();
      this.audioCtx = null;
    }
  }

  /**
   * Local microphone diagnostic: opens the real mic, captures ~700ms of audio,
   * computes RMS/peak from the ACTUAL captured frames, and releases the device.
   * The audio is NEVER forwarded to the main process or anywhere else — frames
   * are analysed in-process only.
   *
   * If capture is already active (listening), the diagnostic runs on the live
   * stream and restores the prior state — it never kills an active session.
   */
  public async runDiagnostic(): Promise<IAudioDiagnosticResult> {
    const wasCapturing = this._isCapturing;
    const rmsSamples: number[] = [];
    try {
      if (wasCapturing) {
        this.forwarding = false;
      } else {
        await this.startRecording(
          amp => {
            rmsSamples.push(amp);
          },
          false,
        );
      }
      if (!this.audioCtx || !this.stream) {
        return { ok: false, error: 'microphone could not be opened' };
      }
      const deadline = performance.now() + 700;
      while (performance.now() < deadline) {
        await new Promise(r => setTimeout(r, 30));
      }
      if (wasCapturing) {
        const prevCb = this.onAmplitudeCb;
        this.onAmplitudeCb = amp => {
          rmsSamples.push(amp);
        };
        const measureUntil = performance.now() + 700;
        while (performance.now() < measureUntil) {
          await new Promise(r => setTimeout(r, 30));
        }
        this.onAmplitudeCb = prevCb;
      }
      if (rmsSamples.length === 0) {
        return { ok: false, error: 'captured 0 frames from the microphone' };
      }
      let peak = 0;
      let sum = 0;
      for (const s of rmsSamples) {
        peak = Math.max(peak, s);
        sum += s * s;
      }
      const rms = Math.sqrt(sum / rmsSamples.length);
      return {
        ok: true,
        frames: rmsSamples.length * 512,
        rms: Math.round(rms * 1000) / 1000,
        peak: Math.round(peak * 1000) / 1000,
        sampleRate: this.audioCtx?.sampleRate ?? TARGET_SAMPLE_RATE,
        hasSignal: peak > 0.005,
      };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    } finally {
      if (wasCapturing) {
        this.forwarding = true;
      } else {
        this.stopRecording();
      }
    }
  }
}

export const audioRecorder = new AudioRecorder();
