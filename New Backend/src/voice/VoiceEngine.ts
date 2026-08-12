// New Backend — voice/VoiceEngine.ts
// Voice Engine. Owns the voice lifecycle state machine (wake, listening,
// reasoning, speaking, barge-in) and the audio routing policy. It does NOT
// redesign any UI — it drives the existing voice surface. Voice output remains
// Charon via Gemini Live; local Whisper is the low-latency transcription path.
import { EventEmitter } from 'node:events';
import type { VoiceEvent, VoiceState } from '../contracts/domain.js';
import { logger } from '../core/logger.js';

export interface VoiceLifecycle {
  currentState: VoiceState;
  lastWakeAt: number | null;
  listening: boolean;
}

export class VoiceEngine extends EventEmitter {
  private _state: VoiceState = 'IDLE';
  private lastWakeAt: number | null = null;
  private listening = false;

  constructor(private readonly wakeWord = 'NOVA') {
    super();
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

  /** Wake word detected — interrupt any current output and start listening. */
  wake(): void {
    this.lastWakeAt = Date.now();
    this.listening = true;
    this.transition('LISTENING');
    this.emit('event', 'wake' as VoiceEvent);
    // Barge-in: if NOVA was speaking, an interruption cancel is issued by the
    // audio bridge handler; here we just flip the lifecycle.
    logger.debug('[voice] wake word detected', { wakeWord: this.wakeWord });
  }

  onUtteranceStart(): void {
    this.listening = true;
    this.transition('LISTENING');
    this.emit('event', 'utterance_start');
  }

  /** User stopped speaking — finalize immediately, don't wait. */
  onUtteranceEnd(): void {
    this.listening = false;
    this.transition('PROCESSING');
    this.emit('event', 'utterance_end');
  }

  /** New spoken text (partial or final) for the transcript surface. */
  onSpeech(text: string, partial: boolean): void {
    this.emit('event', 'speech' as VoiceEvent, { text, partial });
  }

  reasoning(): void {
    this.transition('REASONING');
    this.emit('event', 'reasoning');
  }

  speaking(): void {
    this.transition('SPEAKING');
    this.emit('event', 'speaking');
  }

  idle(): void {
    this.transition('IDLE');
    this.emit('event', 'idle');
  }

  /** Barge-in: user interrupted NOVA's output. */
  bargeIn(): void {
    this.emit('event', 'barge_in');
    this.wake();
  }

  onError(err: unknown): void {
    this.emit('event', 'error', { error: err instanceof Error ? err.message : String(err) });
    this.transition('IDLE');
    logger.warn('[voice] voice error', { error: String(err) });
  }
}
