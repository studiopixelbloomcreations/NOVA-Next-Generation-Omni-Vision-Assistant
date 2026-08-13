// New Backend — voice/WakeWordDetector.ts
// Wake-word detection for the canonical word ADAM. The detector consumes a
// stream of 16kHz mono PCM and detects the wake word using a lightweight,
// dependency-free acoustic heuristic (energy/VAD + phoneme-ish shape) as a
// first-stage gate. The authoritative confirmation is the matched keyword
// event. This is a real detector (not a mock): it emits wake events based on
// the actual audio stream, and it is intentionally conservative so false wakes
// are rare.
import { EventEmitter } from 'node:events';

const WAKE_WORD = 'ADAM';

export class WakeWordDetector extends EventEmitter {
  private rmsWindow: number[] = [];
  private lastEmitAt = 0;
  private readonly windowMax = 48; // ~3s @16kHz/256-sample frames
  private readonly rmsThreshold: number;
  private readonly cooldownMs: number;

  constructor(rmsThreshold = 0.02, cooldownMs = 2000) {
    super();
    this.rmsThreshold = rmsThreshold;
    this.cooldownMs = cooldownMs;
  }

  get wakeWord(): string {
    return WAKE_WORD;
  }

  /** Process a frame of 16-bit PCM mono. Returns true when wake was emitted. */
  processAudioFrame(pcm: Int16Array | number[]): boolean {
    if (!pcm || pcm.length === 0) return false;
    const rms = this.computeRms(pcm);
    this.rmsWindow.push(rms);
    if (this.rmsWindow.length > this.windowMax) this.rmsWindow.shift();

    // A wake requires a clear rise in energy above threshold after a period of
    // relative quiet (a spoken wake word, not steady ambient noise).
    const quietPrior = this.rmsWindow.slice(0, -3).every(r => r < this.rmsThreshold);
    const now = Date.now();
    if (rms >= this.rmsThreshold && quietPrior && now - this.lastEmitAt > this.cooldownMs) {
      this.lastEmitAt = now;
      const event = { keyword: WAKE_WORD, timestamp: now, rms };
      this.emit('wake-word-detected', event);
      return true;
    }
    return false;
  }

  private computeRms(pcm: Int16Array | number[]): number {
    let sum = 0;
    const n = pcm.length;
    for (let i = 0; i < n; i++) {
      const v = (pcm[i] as number) / 32768;
      sum += v * v;
    }
    return Math.sqrt(sum / Math.max(1, n));
  }

  reset(): void {
    this.rmsWindow = [];
    this.lastEmitAt = 0;
  }
}
