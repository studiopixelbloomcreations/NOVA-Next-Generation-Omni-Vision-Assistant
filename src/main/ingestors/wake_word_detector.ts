// src/main/ingestors/wake_word_detector.ts
import { EventEmitter } from 'events';

export class WakeWordDetector extends EventEmitter {
  private isActive = false;
  private audioBuffer: Int16Array[] = [];
  private bufferSize = 0;

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

    // TODO: Implement actual wake word detection here
    // For now, we'll use a simple energy-based fallback
    // In production, integrate @picovoice/porcupine-node with PICOVOICE_ACCESS_KEY
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