// New Backend — voice/VoiceEngine.ts
// Voice Engine (System 29). Owns the complete always-on voice lifecycle for the
// canonical wake word ADAM: wake detection, low-latency listening, streaming
// transcription, understanding/planning/execution states, Charon speaking, and
// barge-in interruption. It coordinates the WakeWordDetector, MicCapture,
// WhisperTranscriber, GeminiLiveBridge and CharonTTS. It never changes the UI.
import { EventEmitter } from 'node:events';
import type { VoiceState } from '../contracts/domain.js';
import { Identity } from '../contracts/identity.js';
import { logger } from '../core/logger.js';
import { WakeWordDetector } from './WakeWordDetector.js';
import { MicCapture } from './MicCapture.js';
import { WhisperTranscriber } from './WhisperTranscriber.js';
import { GeminiLiveBridge } from './GeminiLiveBridge.js';
import { CharonTTS } from './CharonTTS.js';

export interface VoiceLifecycle {
  currentState: VoiceState;
  lastWakeAt: number | null;
  listening: boolean;
}

export class VoiceEngine extends EventEmitter {
  readonly wakeWord: string;
  readonly wakeDetector: WakeWordDetector;
  readonly mic: MicCapture;
  readonly whisper: WhisperTranscriber;
  readonly live: GeminiLiveBridge;
  readonly charon: CharonTTS;

  private _state: VoiceState = 'IDLE';
  private lastWakeAt: number | null = null;
  private listening = false;

  constructor(
    wakeWordDetector: WakeWordDetector,
    micCapture: MicCapture,
    whisperTranscriber: WhisperTranscriber,
    liveBridge: GeminiLiveBridge,
    charonTTS: CharonTTS,
  ) {
    super();
    this.wakeWord = Identity.wakeWord;
    this.wakeDetector = wakeWordDetector;
    this.mic = micCapture;
    this.whisper = whisperTranscriber;
    this.live = liveBridge;
    this.charon = charonTTS;
  }

  get state(): VoiceState {
    return this._state;
  }

  snapshot(): VoiceLifecycle {
    return { currentState: this._state, lastWakeAt: this.lastWakeAt, listening: this.listening };
  }

  private transition(next: VoiceState): void {
    if (this._state === next) return;
    this._state = next;
    this.emit('state-change', this.snapshot());
  }

  /**
   * Start the always-on voice loop: begin mic capture and listen for ADAM.
   * Returns the wire-up for audio frames so the host can feed the PCM stream.
   */
  start(): void {
    this.mic.markReady(null);
    this.wakeDetector.reset();
    // Forward wake events to the lifecycle and barge-in handling.
    this.wakeDetector.on('wake-word-detected', () => this.onWake());
    // If Gemini Live is speaking and a wake arrives, cancel current output.
    this.on('event', (e: string) => {
      if (e === 'wake') this.handleBargeIn();
    });
    this.transition('IDLE');
    logger.info(`[voice] always-on voice active (wake word: ${this.wakeWord})`);
  }

  /** Feed a PCM frame into the wake detector and transcriber. */
  processAudioFrame(pcm: Int16Array | number[]): void {
    this.wakeDetector.processAudioFrame(pcm);
    if (this.whisper.isSpeaking()) this.whisper.pushAudio(pcm);
  }

  private handleBargeIn(): void {
    // If currently speaking, interrupt immediately and capture the new input.
    if (this._state === 'SPEAKING') {
      this.live.triggerInterruptionCancel();
      this.charon.emit('interrupt');
    }
  }

  /** Wake word ADAM detected. */
  onWake(): void {
    this.lastWakeAt = Date.now();
    this.listening = true;
    this.handleBargeIn();
    this.transition('LISTENING');
    this.emit('event', 'wake');
    logger.debug('[voice] wake word detected', { wakeWord: this.wakeWord });
  }

  onUtteranceStart(): void {
    this.listening = true;
    this.whisper.startUtterance();
    this.transition('LISTENING');
    this.emit('event', 'utterance_start');
  }

  /** User stopped speaking — finalize immediately with low latency. */
  async onUtteranceEnd(): Promise<void> {
    this.listening = false;
    this.transition('PROCESSING');
    const text = await this.whisper.endUtterance();
    this.emit('event', 'utterance_end');
    if (text.trim()) this.emit('transcript-final', text.trim());
  }

  onSpeech(text: string, partial: boolean): void {
    this.emit('event', 'speech', { text, partial });
  }

  reasoning(): void { this.transition('REASONING'); this.emit('event', 'reasoning'); }
  speaking(): void { this.transition('SPEAKING'); this.emit('event', 'speaking'); }
  idle(): void { this.transition('IDLE'); this.emit('event', 'idle'); }

  /** Speak a response in the Charon voice, marking the speaking state. */
  async speak(text: string): Promise<boolean> {
    this.transition('SPEAKING');
    const ok = await this.charon.speak(text);
    this.transition('IDLE');
    return ok;
  }

  bargeIn(): void {
    this.emit('event', 'barge_in');
    this.onWake();
  }

  onError(err: unknown): void {
    this.emit('event', 'error', { error: err instanceof Error ? err.message : String(err) });
    this.transition('IDLE');
    logger.warn('[voice] voice error', { error: String(err) });
  }

  stop(): void {
    this.listening = false;
    this.transition('IDLE');
    logger.info('[voice] voice loop stopped');
  }
}
