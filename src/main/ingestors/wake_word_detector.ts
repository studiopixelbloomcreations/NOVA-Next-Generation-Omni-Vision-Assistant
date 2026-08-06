// src/main/ingestors/wake_word_detector.ts
import { EventEmitter } from 'events';

export class WakeWordDetector extends EventEmitter {
  private isActive = false;
  private audioBuffer: Int16Array[] = [];
  private bufferSize = 0;
  private lastDetection = 0;

  constructor() {
    super();
  }

  async initialize(): Promise<void> {
    console.log('[WakeWordDetector] Initialized (fallback mode - no Porcupine access key)');
    // Porcupine requires an access key from Picovoice Console.
    // For production, set PICOVOICE_ACCESS_KEY env var and use @picovoice/porcupine-node.
  }

  processAudio(pcmData: Int16Array): void {
    if (!this.isActive) return;

    // Add to ring buffer
    this.audioBuffer.push(pcmData);
    this.bufferSize += pcmData.length;

    // Keep buffer at max size (2500ms = 40000 samples at 16kHz)
    const maxSamples = 40000;
    while (this.bufferSize > maxSamples) {
      const removed = this.audioBuffer.shift();
      if (removed) this.bufferSize -= removed.length;
    }

    // Simple energy-based wake word fallback.
    // Compute RMS for the incoming chunk and emit 'wake-word-detected' when it exceeds a threshold.
    // Threshold can be tuned via PICOVOICE_FALLBACK_THRESHOLD env var (integer RMS value).
    const computeRms = (samples: Int16Array): number => {
      let sum = 0;
      for (let i = 0; i < samples.length; i++) {
        const v = samples[i];
        sum += v * v;
      }
      return Math.sqrt(sum / Math.max(1, samples.length));
    };

    const thresholdEnv = process.env.PICOVOICE_FALLBACK_THRESHOLD;
    const threshold = thresholdEnv ? parseInt(thresholdEnv, 10) : 1500;

    const rms = computeRms(pcmData);
    const now = Date.now();
    // Require a modest amount of buffered audio for context and debounce between detections.
    if (this.bufferSize >= 8000 && rms > threshold && now - this.lastDetection > 2000) {
      this.lastDetection = now;
      const buffer = this.getRingBuffer();
      this.emit('wake-word-detected', { buffer, keyword: 'fallback', timestamp: now });
    }
  }

  getRingBuffer(): Int16Array {
    const totalSamples = this.audioBuffer.reduce((sum, chunk) => sum + chunk.length, 0);
    const combined = new Int16Array(totalSamples);
    let offset = 0;
    for (const chunk of this.audioBuffer) {
      combined.set(chunk, offset);
      offset += chunk.length;
    }
    return combined;
  }

  start(): void {
    this.isActive = true;
    console.log('[WakeWordDetector] Wake word detection started (fallback mode)');
  }

  stop(): void {
    this.isActive = false;
    this.audioBuffer = [];
    this.bufferSize = 0;
    console.log('[WakeWordDetector] Wake word detection stopped');
  }

  async release(): Promise<void> {
    this.stop();
  }

  isReady(): boolean {
    return true; // Always ready in fallback mode
  }
}

export const wakeWordDetector = new WakeWordDetector();
