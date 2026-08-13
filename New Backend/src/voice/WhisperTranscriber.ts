// New Backend — voice/WhisperTranscriber.ts
// Low-latency streaming transcription via local Whisper (faster_whisper in the
// Python runtime). Buffers PCM frames during an utterance and finalizes as soon
// as the user stops speaking (no unnecessary delay). Fallback to Gemini Live
// transcription is handled by the VoiceEngine; this is the offline/streaming
// path.
import { EventEmitter } from 'node:events';
import type { PythonRuntimeBridge } from '../execution/PythonRuntimeBridge.js';

export class WhisperTranscriber extends EventEmitter {
  private buffer: number[] = [];
  private speaking = false;
  private readonly frameSize: number;

  constructor(private readonly bridge: PythonRuntimeBridge, sampleRate = 16000, frameMs = 64) {
    super();
    this.frameSize = Math.round((sampleRate * frameMs) / 1000);
  }

  pushAudio(pcm: Int16Array | number[]): void {
    for (const v of pcm) this.buffer.push(v);
  }

  startUtterance(): void {
    this.speaking = true;
    this.buffer = [];
  }

  /** End of speech — finalize immediately by transcribing the buffered PCM. */
  async endUtterance(): Promise<string> {
    this.speaking = false;
    if (this.buffer.length === 0) return '';
    const pcm = this.buffer;
    this.buffer = [];
    try {
      // Convert to base64 for the Python runtime (avoids a huge arg line).
      const bytes = new Int16Array(pcm);
      const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const res = await this.bridge.audioCmd<{ success?: boolean; text?: string; error?: string }>(
        'transcribe',
        { pcm_base64: buf.toString('base64'), samplerate: 16000, language: 'en' },
        30000,
      );
      const data = res.data;
      if (res.ok && data?.success === true && data.text) {
        this.emit('final', data.text);
        return data.text;
      }
      const error = data?.error ?? res.error ?? 'transcription unavailable';
      this.emit('error', new Error(error));
      return '';
    } catch (err) {
      this.emit('error', err instanceof Error ? err : new Error(String(err)));
      return '';
    }
  }

  cancel(): void {
    this.buffer = [];
    this.speaking = false;
  }

  isSpeaking(): boolean {
    return this.speaking;
  }

  get bufferedSamples(): number {
    return this.buffer.length;
  }
}
