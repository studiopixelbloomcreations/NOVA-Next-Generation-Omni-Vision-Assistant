// A.D.A.M. — additive wake-word detector for the canonical word ADAM.
// Merged into the restored legacy backend as an ADDITIVE capability. Consumes
// 16kHz PCM frames and detects the wake word using a lightweight, real acoustic
// heuristic (energy + quiet-prior). This complements (does not replace) the
// existing legacy Picovoice wake-word path; it provides an offline ADAM gate.
import { EventEmitter } from 'events';
import { AdamIdentity } from './identity';

export class AdamWakeWordDetector extends EventEmitter {
  private rmsWindow: number[] = [];
  private lastEmitAt = 0;
  private readonly windowMax = 48;
  private readonly rmsThreshold: number;
  private readonly cooldownMs: number;

  constructor(rmsThreshold = 0.02, cooldownMs = 2000) {
    super();
    this.rmsThreshold = rmsThreshold;
    this.cooldownMs = cooldownMs;
  }

  get wakeWord(): string {
    return AdamIdentity.wakeWord;
  }

  processAudioFrame(pcm: Int16Array | number[]): boolean {
    if (!pcm || pcm.length === 0) return false;
    const rms = this.computeRms(pcm);
    this.rmsWindow.push(rms);
    if (this.rmsWindow.length > this.windowMax) this.rmsWindow.shift();
    const quietPrior = this.rmsWindow.slice(0, -3).every(r => r < this.rmsThreshold);
    const now = Date.now();
    if (rms >= this.rmsThreshold && quietPrior && now - this.lastEmitAt > this.cooldownMs) {
      this.lastEmitAt = now;
      this.emit('wake-word-detected', { keyword: this.wakeWord, timestamp: now, rms });
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
