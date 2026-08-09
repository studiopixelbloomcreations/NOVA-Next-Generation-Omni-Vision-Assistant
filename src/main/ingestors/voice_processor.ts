// src/main/ingestors/voice_processor.ts
import { EventEmitter } from 'events';
import { WakeWordDetector } from './wake_word_detector';

// End a turn promptly after the user stops speaking. Gemini Live has its own
// server VAD, while local Whisper needs this only to emit the final segment.
const SILENCE_HOLD_MS = 300;

export class VoiceProcessor extends EventEmitter {
  private speaking: boolean = false;
  private silenceTimer: NodeJS.Timeout | null = null;
  private vad: any = null;
  private vadInitialized = false;
  private wakeWordDetector: WakeWordDetector | null = null;

  constructor() {
    super();
    this.initVAD();
  }

  public setWakeWordDetector(detector: WakeWordDetector): void {
    this.wakeWordDetector = detector;
  }

  private async initVAD(): Promise<void> {
    try {
      // Load the optional native VAD lazily. A packaged Electron install may
      // not have a matching ONNX/VAD binary even though the core application
      // and microphone PCM path are usable. A top-level import made that
      // packaging mismatch terminate NOVA before its window was created.
      // When unavailable, processAudio uses the real amplitude fallback.
      const vadModule = require('@ricky0123/vad-node') as { NonRealTimeVAD?: any };
      const NonRealTimeVAD = vadModule.NonRealTimeVAD;
      if (!NonRealTimeVAD) throw new Error('VAD native module is unavailable');
      this.vad = await NonRealTimeVAD.new({
        positiveSpeechThreshold: 0.5,
        negativeSpeechThreshold: 0.35,
        minSpeechFrames: 2,
        preSpeechPadFrames: 1,
        redemptionFrames: 8,
      });
      await this.vad.init();
      this.vadInitialized = true;
      console.log('[VoiceProcessor] Silero VAD initialized');
    } catch (err) {
      console.error('[VoiceProcessor] Failed to initialize Silero VAD:', err);
      this.vadInitialized = false;
    }
  }

  /**
   * Process raw PCM audio through Silero VAD
   * Returns speech probability (0-1)
   */
  async processAudio(pcmData: Int16Array): Promise<number> {
    if (!this.vad || !this.vadInitialized) {
      // Fallback to amplitude-based detection
      return this.fallbackAmplitudeDetection(pcmData);
    }

    try {
      // Silero expects Float32Array at 16kHz, normalized to [-1, 1]
      const frameSize = 1536;

      // Process in frames of frameSize samples
      let totalSpeechProb = 0;
      let frameCount = 0;

      for (let offset = 0; offset + frameSize <= pcmData.length; offset += frameSize) {
        const frame = pcmData.slice(offset, offset + 1536);
        const float32Data = new Float32Array(1536);
        for (let i = 0; i < 1536; i++) {
          float32Data[i] = frame[i] / 32768;
        }

        try {
          const result = await this.vad.frameProcessor.process(float32Data);
          totalSpeechProb += result.probs.isSpeech;
          frameCount++;
        } catch (err) {
          console.error('[VoiceProcessor] Frame processing error:', err);
        }
      }

      if (frameCount > 0) {
        return totalSpeechProb / frameCount;
      }

      return 0;
    } catch (err) {
      console.error('[VoiceProcessor] VAD prediction error:', err);
      return this.fallbackAmplitudeDetection(pcmData);
    }
  }

  private fallbackAmplitudeDetection(pcmData: Int16Array): number {
    let sum = 0;
    for (let i = 0; i < pcmData.length; i++) {
      const sample = pcmData[i] / 32768;
      sum += sample * sample;
    }
    const rms = Math.sqrt(sum / pcmData.length);
    // Rough probability mapping
    return Math.min(1, rms * 10);
  }

  /**
   * Public method to report speaking state from renderer amplitude
   * Kept for backward compatibility with renderer amplitude reporting
   */
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

  /**
   * Process audio through VAD and update speaking state
   * Returns true if speech detected
   */
  async processAndUpdate(pcmData: Int16Array): Promise<boolean> {
    const prob = await this.processAudio(pcmData);
    this.wakeWordDetector?.processAudio(pcmData);
    const isSpeech = prob >= 0.5;

    if (isSpeech) {
      this.clearSilenceTimer();
      if (!this.speaking) {
        this.speaking = true;
        this.emit('speaking-start');
      }
      return true;
    }

    if (!this.speaking || this.silenceTimer) return false;

    this.silenceTimer = setTimeout(() => {
      this.silenceTimer = null;
      this.speaking = false;
      this.emit('speaking-end');
    }, SILENCE_HOLD_MS);

    return false;
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
