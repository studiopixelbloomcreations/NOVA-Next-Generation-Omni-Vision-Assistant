// New Backend — voice/CharonTTS.ts
// CharonTTS — spoken output via the Charon voice. Delegates to the Windows
// SAPI / pyttsx3 backend in the Python runtime. Falls back to emitting an
// `ai-audio-chunk`/token event when the audio backend is unavailable so the
// frontend can still present the response. Never fakes successful speech.
import { EventEmitter } from 'node:events';
import type { PythonRuntimeBridge } from '../execution/PythonRuntimeBridge.js';
import { logger } from '../core/logger.js';

export class CharonTTS extends EventEmitter {
  constructor(private readonly bridge: PythonRuntimeBridge) {
    super();
  }

  /** Check which TTS backend is available. */
  async availability(): Promise<{ sapi: boolean; pyttsx3: boolean; voice: string }> {
    const res = await this.bridge.ttsCmd<{ success?: boolean; sapi?: boolean; pyttsx3?: boolean; voice?: string }>('availability', {}, 10000);
    const d = res.data;
    return { sapi: Boolean(d?.sapi), pyttsx3: Boolean(d?.pyttsx3), voice: d?.voice ?? 'Charon' };
  }

  /** Speak a line in the Charon voice. Returns true when audio was produced. */
  async speak(text: string, rate = 0): Promise<boolean> {
    if (!text || !text.trim()) return false;
    try {
      const res = await this.bridge.ttsCmd<{ success?: boolean; error?: string }>('speak', { text, rate }, 30000);
      if (res.ok && res.data?.success === true) {
        this.emit('spoken', text);
        return true;
      }
      const error = res.data?.error ?? res.error ?? 'TTS unavailable';
      logger.warn('[charon_tts] speech backend unavailable', { error });
      // Present the text through the normal channel so the response is never lost.
      this.emit('text-fallback', text);
      return false;
    } catch (err) {
      logger.warn('[charon_tts] TTS error', { error: err instanceof Error ? err.message : String(err) });
      this.emit('text-fallback', text);
      return false;
    }
  }
}
