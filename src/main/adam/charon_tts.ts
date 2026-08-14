// A.D.A.M. — additive Charon TTS.
// Merged into the restored legacy backend as an ADDITIVE capability.
// In the legacy architecture the spoken Charon voice is produced by Gemini
// Live's native audio output (voiceName "Charon"), not by a Python TTS
// backend. This additive module therefore (a) reports whether audio output is
// available via the real legacy Python audio service, and (b) provides a
// text-fallback emission so a response is never lost even when the audio path
// is unavailable. It never fakes speech.
import { EventEmitter } from 'events';
import type { PythonRuntime } from '../services/python_runtime';
import { AdamIdentity } from './identity';

export class AdamCharonTTS extends EventEmitter {
  constructor(private readonly python: PythonRuntime) {
    super();
  }

  /** Check whether the real audio output path exists (via legacy Python). */
  async availability(): Promise<{ audioAvailable: boolean; voice: string }> {
    try {
      const res = await this.python.request('audio.devices', {}, 10000);
      const data = res.data as { ok?: boolean; outputs?: unknown[] } | null;
      return { audioAvailable: Boolean(res.ok && data?.ok), voice: AdamIdentity.voice };
    } catch {
      return { audioAvailable: false, voice: AdamIdentity.voice };
    }
  }

  /** Present a spoken line. Returns true when audio is available (Gemini Live
   * will synthesize Charon); otherwise emits a text fallback so nothing is lost. */
  async speak(text: string): Promise<boolean> {
    if (!text || !text.trim()) return false;
    const avail = await this.availability();
    if (avail.audioAvailable) {
      this.emit('spoken', text);
      return true;
    }
    this.emit('text-fallback', text);
    return false;
  }
}
