import { EventEmitter } from 'events';
import { pythonRuntime } from './python_runtime';

// Send short frames so the first partial is not held behind a long audio
// buffer. The Python side throttles decoding independently when inference is
// still busy, so this keeps capture responsive without spawning decoders.
const FLUSH_BYTES = 16000 * 2 * 0.20;

/** Streams microphone PCM to the persistent Python faster-whisper worker. */
export class WhisperLiveBridge extends EventEmitter {
  private pending = Buffer.alloc(0);
  private flushing = false;
  private queuedEnd = false;

  public pushAudio(pcm: Buffer): void {
    this.pending = Buffer.concat([this.pending, pcm]);
    if (this.pending.length >= FLUSH_BYTES) void this.flush(false);
  }

  public endSpeech(): void {
    this.queuedEnd = true;
    if (!this.flushing) void this.flush(true);
  }

  public async reset(): Promise<void> {
    this.pending = Buffer.alloc(0);
    this.queuedEnd = false;
    await pythonRuntime.request('whisper.reset', {}, 5000);
  }

  private async flush(forceEnd: boolean): Promise<void> {
    if (this.flushing) return;
    if (!this.pending.length && !forceEnd) return;
    this.flushing = true;
    const audio = this.pending;
    this.pending = Buffer.alloc(0);
    const speechEnd = forceEnd || this.queuedEnd;
    this.queuedEnd = false;
    try {
      const response = await pythonRuntime.request(
        'whisper.audio',
        { pcm_base64: audio.toString('base64'), speech_end: speechEnd },
        // The normal path is sub-second, but the first request must allow the
        // cached model to initialize on slower Windows machines. Startup now
        // warms it proactively; this remains a safe recovery margin.
        120000,
      );
      if (!response.ok) {
        this.emit('error', new Error(response.error ?? 'Whisper worker unavailable'));
      } else if (response.data && typeof response.data === 'object') {
        const data = response.data as { text?: string; partial?: boolean };
        if (data.text) this.emit(data.partial ? 'partial' : 'final', data.text);
        if (!data.partial) await this.reset();
      }
    } finally {
      this.flushing = false;
      if (this.pending.length >= FLUSH_BYTES || this.queuedEnd) void this.flush(this.queuedEnd);
    }
  }
}

export const whisperLiveBridge = new WhisperLiveBridge();
