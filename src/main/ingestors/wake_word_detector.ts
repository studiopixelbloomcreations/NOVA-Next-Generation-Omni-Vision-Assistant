// src/main/ingestors/wake_word_detector.ts
import { EventEmitter } from 'events';
import { existsSync } from 'fs';
import { join } from 'path';
import { logger } from '../core/logger';

let PorcupineClass: typeof import('@picovoice/porcupine-node').Porcupine | null = null;
try {
  const mod = require('@picovoice/porcupine-node');
  PorcupineClass = mod.Porcupine;
} catch {
  PorcupineClass = null;
}

export interface WakeWordEvent {
  buffer: Int16Array;
  keyword: string;
  timestamp: number;
}

export class WakeWordDetector extends EventEmitter {
  private isActive = false;
  private audioBuffer: Int16Array[] = [];
  private bufferSize = 0;
  private lastDetection = 0;
  private porcupineInstance: any = null;
  private mode: 'real-porcupine' | 'fallback-rms' = 'fallback-rms';

  constructor() {
    super();
  }

  async initialize(): Promise<void> {
    const accessKey = process.env.PICOVOICE_ACCESS_KEY;
    const keywordPaths = [
      join(__dirname, '..', '..', 'native_modules', 'keyword_files', 'porcupine.ppn'),
      join(__dirname, '..', '..', 'native_modules', 'keyword_files', 'wake_word.ppn'),
    ];
    let keywordPath: string | undefined;
    for (const p of keywordPaths) {
      if (existsSync(p)) {
        keywordPath = p;
        break;
      }
    }

    if (accessKey && keywordPath && PorcupineClass) {
      try {
        const instance = (PorcupineClass as any).fromKeywordPaths
          ? (PorcupineClass as any).fromKeywordPaths(accessKey, [keywordPath], [0.5])
          : new (PorcupineClass as any)(accessKey, keywordPath, 0.5);
        this.porcupineInstance = instance;
        this.mode = 'real-porcupine';
        logger.info('[WakeWordDetector] Porcupine initialized with keyword file', { keywordPath });
      } catch (err) {
        logger.error('[WakeWordDetector] Failed to initialize Porcupine, falling back to RMS mode', {
          error: err instanceof Error ? err.message : String(err),
        });
        this.mode = 'fallback-rms';
      }
    } else {
      const reason = !accessKey
        ? 'no PICOVOICE_ACCESS_KEY'
        : !keywordPath
          ? 'no keyword file found'
          : '@picovoice/porcupine-node not available';
      logger.info('[WakeWordDetector] Initialized', { mode: this.mode, reason });
    }
  }

  processAudio(pcmData: Int16Array): void {
    if (!this.isActive) return;

    this.audioBuffer.push(pcmData);
    this.bufferSize += pcmData.length;

    const maxSamples = 40000;
    while (this.bufferSize > maxSamples) {
      const removed = this.audioBuffer.shift();
      if (removed) this.bufferSize -= removed.length;
    }

    if (this.mode === 'real-porcupine' && this.porcupineInstance) {
      try {
        const keywordIndex = this.porcupineInstance.process(pcmData);
        if (keywordIndex !== -1) {
          const now = Date.now();
          const buffer = this.getRingBuffer();
          this.emit('wake-word-detected', { buffer, keyword: 'porcupine', timestamp: now });
        }
      } catch (err) {
        logger.error('[WakeWordDetector] Porcupine process error', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return;
    }

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
    logger.info('[WakeWordDetector] Wake word detection started', { mode: this.mode });
  }

  stop(): void {
    this.isActive = false;
    this.audioBuffer = [];
    this.bufferSize = 0;
    logger.info('[WakeWordDetector] Wake word detection stopped');
  }

  async release(): Promise<void> {
    if (this.porcupineInstance) {
      try {
        this.porcupineInstance.release();
      } catch (err) {
        logger.error('[WakeWordDetector] Failed to release Porcupine instance', {
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        this.porcupineInstance = null;
      }
    }
    this.stop();
  }

  isReady(): boolean {
    return true;
  }
}

export const wakeWordDetector = new WakeWordDetector();
