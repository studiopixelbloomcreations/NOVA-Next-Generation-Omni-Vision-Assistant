// src/main/ingestors/voice_processor.ts
import { EventEmitter } from 'events';

// Renderer amplitude reports arrive per audio buffer (~8Hz). Without hysteresis
// every report re-triggers interruption handling; with it, only edges do.
const SILENCE_HOLD_MS = 800;

/**
 * Main-process speaking-state tracker. Mic capture itself runs in the renderer
 * (audio_recorder.ts); this consolidates its per-buffer speaking reports into
 * edge-triggered 'speaking-start' / 'speaking-end' events so downstream
 * consumers (interruption cancel, voice-state broadcast) fire once per
 * transition instead of once per audio buffer.
 */
export class VoiceProcessor extends EventEmitter {
  private speaking: boolean = false;
  private silenceTimer: NodeJS.Timeout | null = null;

  public reportSpeaking(isSpeaking: boolean): void {
    if (isSpeaking) {
      this.clearSilenceTimer();
      if (!this.speaking) {
        this.speaking = true;
        this.emit('speaking-start');
      }
      return;
    }

    if (!this.speaking || this.silenceTimer) return;

    this.silenceTimer = setTimeout(() => {
      this.silenceTimer = null;
      this.speaking = false;
      this.emit('speaking-end');
    }, SILENCE_HOLD_MS);
  }

  public isSpeaking(): boolean {
    return this.speaking;
  }

  public stop(): void {
    this.clearSilenceTimer();
    this.speaking = false;
  }

  private clearSilenceTimer(): void {
    if (this.silenceTimer) {
      clearTimeout(this.silenceTimer);
      this.silenceTimer = null;
    }
  }
}

export const voiceProcessor = new VoiceProcessor();
