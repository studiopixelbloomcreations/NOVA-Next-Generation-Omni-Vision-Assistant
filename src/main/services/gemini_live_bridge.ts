// src/main/services/gemini_live_bridge.ts
import { EventEmitter } from 'events';
import { BrowserWindow } from 'electron';
import { performance } from 'perf_hooks';
import WebSocket from 'ws';
import { NovaConfig } from '../core/config';
import { personalityEngine } from './personality_engine';

type ConnectionState = 'DISCONNECTED' | 'CONNECTING' | 'CONNECTED' | 'ERROR';

const RECONNECT_BASE_DELAY_MS = 1000;
const RECONNECT_MAX_DELAY_MS = 30000;
const RECONNECT_JITTER_RATIO = 0.2;
const HEARTBEAT_INTERVAL_MS = 15000;
const STALE_CONNECTION_MS = HEARTBEAT_INTERVAL_MS * 2;

export class GeminiLiveBridge extends EventEmitter {
  private apiKey: string;
  private ws: WebSocket | null = null;
  private connected: boolean = false;
  private sessionReady: boolean = false;
  private connectionState: ConnectionState = 'DISCONNECTED';
  private latencyMs: number = 0;
  private lastPingSentAt: number = 0;
  private lastPongAt: number = 0;
  private keepAliveTimer: NodeJS.Timeout | null = null;
  private toolDeclarations: unknown[] = [];

  private intentionalClose = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectDelayMs = RECONNECT_BASE_DELAY_MS;
  private reconnectAttempts = 0;

  private pendingUserTranscript = '';
  private pendingModelResponse = '';

  private malformedFrameLogged = false;

  constructor(apiKey: string) {
    super();
    this.apiKey = apiKey;
  }

  public setToolDeclarations(tools: unknown[]): void {
    this.toolDeclarations = tools || [];
  }

  /**
   * The canonical voice requested from Gemini Live Native Audio. The bridge
   * reads NovaConfig.ai.liveVoice (single source of truth) — there is no
   * second voice configuration anywhere in the codebase.
   */
  public getVoiceName(): string {
    return NovaConfig.ai.liveVoice;
  }

  /**
   * Builds the Gemini Live session setup frame. Public so the voice/persona
   * configuration can be verified in tests without a live socket: the frame
   * must carry Gacrux and the Personality Engine system instruction.
   */
  public buildSetupMessage(): Record<string, unknown> {
    const setup: Record<string, unknown> = {
      setup: {
        model: NovaConfig.ai.liveModel,
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName: this.getVoiceName() },
            },
          },
        },
        systemInstruction: {
          parts: [{ text: personalityEngine.buildVoiceSystemInstruction() }],
        },
        // Keep server-side VAD enabled, but make turn completion responsive.
        // The default endpointing window can be very conservative for a
        // continuous microphone stream, which makes a short utterance appear
        // stuck until the user has been silent for a long time.
        realtimeInputConfig: {
          automaticActivityDetection: {
            disabled: false,
            prefixPaddingMs: 80,
            silenceDurationMs: 350,
          },
        },
        inputAudioTranscription: {},
        outputAudioTranscription: {},
      },
    };
    if (this.toolDeclarations.length > 0) {
      (setup.setup as Record<string, unknown>).tools = this.toolDeclarations;
    }
    return setup;
  }

  /** Replaces the API key at runtime (used by the SecretStore at boot). */
  public setApiKey(apiKey: string): void {
    this.apiKey = apiKey;
  }

  public connectStream(): void {
    this.clearReconnectTimer();
    this.intentionalClose = false;

    if (!this.apiKey || typeof this.apiKey !== 'string' || this.apiKey.trim() === '') {
      console.warn('[geminiLiveBridge] GEMINI_API_KEY is undefined or empty. Reconnect disabled until configured.');
      this.setConnectionState('ERROR');
      this.emit('error', new Error('GEMINI_API_KEY is missing or empty'));
      return;
    }

    if (this.ws && (this.ws.readyState === WebSocket.CONNECTING || this.ws.readyState === WebSocket.OPEN)) {
      console.log('[geminiLiveBridge] connectStream called while socket is active; maintaining current session.');
      return;
    }

    if (this.ws) {
      this.teardownSocket(1000, 'Reconnecting');
    }

    const apiKey = this.apiKey.trim();
    this.apiKey = apiKey;

    const endpoint = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${encodeURIComponent(this.apiKey)}`;

    console.log('[geminiLiveBridge] Connecting to Gemini Live API...');
    this.setConnectionState('CONNECTING');

    try {
      this.ws = new WebSocket(endpoint);
    } catch (err) {
      console.error('[geminiLiveBridge] Failed to construct WebSocket:', err);
      this.setConnectionState('ERROR');
      this.emit('error', err instanceof Error ? err : new Error(String(err)));
      if (!this.intentionalClose) {
        this.scheduleReconnect();
      }
      return;
    }

    this.ws.on('open', () => {
      console.log('[geminiLiveBridge] WebSocket opened, sending setup frame');
      this.connected = true;
      this.setConnectionState('CONNECTED');

      // The session frame comes from ONE builder: canonical voice (Gacrux via
      // NovaConfig) + the Personality Engine system instruction.
      const setupMessage = this.buildSetupMessage();

      this.safeSend(JSON.stringify(setupMessage), 'setup');
      this.lastPingSentAt = Date.now();
      this.lastPongAt = Date.now();

      this.startHeartbeat();
    });

    this.ws.on('pong', () => {
      this.lastPongAt = Date.now();
      if (this.lastPingSentAt > 0) {
        this.latencyMs = Date.now() - this.lastPingSentAt;
      }
    });

    this.ws.on('message', (raw: WebSocket.Data) => {
      let payload: any;
      try {
        const rawStr = typeof raw === 'string' ? raw : raw.toString('utf8');
        payload = JSON.parse(rawStr);
        this.malformedFrameLogged = false;
      } catch (err) {
        if (!this.malformedFrameLogged) {
          this.malformedFrameLogged = true;
          console.error(
            '[geminiLiveBridge] received malformed (non-JSON) frame; suppressing repeats:',
            err,
          );
        }
        return;
      }

      try {
        const serverContent = payload?.serverContent;

        const toolCallPayload = payload?.toolCall ?? payload?.serverContent?.toolCall;
        if (toolCallPayload) {
          this.emit('tool-call', toolCallPayload);
        }

        if (serverContent?.interrupted) {
          this.emit('audio-buffer-flush');
          this.emitInteractionComplete();
        }

        const inputText: string | undefined = serverContent?.inputTranscription?.text;
        if (inputText) {
          this.pendingUserTranscript += inputText;
          this.emit('user-text-transcribed', inputText);
        }

        const outputText: string | undefined = serverContent?.outputTranscription?.text;
        if (outputText) {
          this.pendingModelResponse += outputText;
          this.broadcastToAllWindows('ai-text-token', outputText);
          this.emit('ai-text-token', outputText);
        }

        const parts: any[] | undefined = serverContent?.modelTurn?.parts;
        if (Array.isArray(parts)) {
          for (const part of parts) {
            if (part.text) {
              this.pendingModelResponse += part.text;
              this.broadcastToAllWindows('ai-text-token', part.text);
              this.emit('ai-text-token', part.text);
            }

            const inlineData = part?.inlineData;
            if (!inlineData) continue;

            const mime: string = inlineData.mimeType ?? '';
            if (mime.startsWith('audio/pcm') && inlineData.data) {
              const pcmBuffer = Buffer.from(inlineData.data, 'base64');
              this.emit('ai-audio-chunk', pcmBuffer);

              const rms = this.computeRmsAmplitude(pcmBuffer);
              this.emit('ai-amplitude', rms);
            }
          }
        }

        if (serverContent?.turnComplete) {
          this.emitInteractionComplete();
        }

        if (payload?.setupComplete || payload?.serverContent?.setupComplete) {
          console.log('[geminiLiveBridge] Setup complete - session ready');
          this.sessionReady = true;
          this.reconnectAttempts = 0;
          this.reconnectDelayMs = RECONNECT_BASE_DELAY_MS;
          this.emit('setup-complete');
        }

        if (payload?.error) {
          console.error('[geminiLiveBridge] Server error:', payload.error);
          this.setConnectionState('ERROR');
          this.emit('error', new Error(typeof payload.error === 'string' ? payload.error : JSON.stringify(payload.error)));
          this.teardownSocket(1008, 'Server error');
          if (!this.intentionalClose) {
            this.scheduleReconnect();
          }
        }
      } catch (evtErr) {
        console.error('[geminiLiveBridge] Exception processing server message:', evtErr);
      }
    });

    this.ws.on('close', (code, reason) => {
      console.log(`[geminiLiveBridge] WebSocket closed: code=${code}, reason=${reason.toString()}`);
      this.connected = false;
      this.sessionReady = false;
      this.setConnectionState('DISCONNECTED');
      this.stopHeartbeat();
      this.ws = null;

      if (!this.intentionalClose) {
        this.scheduleReconnect();
      }
    });

    this.ws.on('error', (err: Error) => {
      console.error('[geminiLiveBridge] WebSocket error:', err.message);
      this.connected = false;
      this.sessionReady = false;
      this.setConnectionState('ERROR');
      this.stopHeartbeat();
      this.emit('error', err instanceof Error ? err : new Error(String(err)));

      if (!this.intentionalClose) {
        this.scheduleReconnect();
      }
    });
  }

  public sendAudioChunk(pcmData: Buffer): void {
    if (!this.ws || !this.connected || !this.sessionReady) return;

    const base64 = pcmData.toString('base64');
    const message = {
      realtimeInput: {
        audio: {
          data: base64,
          mimeType: 'audio/pcm;rate=16000',
        },
      },
    };

    this.safeSend(JSON.stringify(message), 'audio chunk');
  }

  public sendTextMessage(text: string): void {
    if (!this.ws || !this.connected) return;

    // The native-audio model accepts incremental text through realtimeInput
    // (clientContent with turnComplete is rejected with a 1011 internal error
    // on this model, and a bare realtimeInput.text turn works in practice).
    const message = {
      realtimeInput: {
        text,
      },
    };

    this.safeSend(JSON.stringify(message), 'text message');
  }

  public sendToolResponse(
    functionResponses: Array<{ id: string; name: string; response: unknown }>,
  ): void {
    if (!this.ws || !this.connected) return;
    const message = {
      toolResponse: {
        functionResponses,
      },
    };
    this.safeSend(JSON.stringify(message), 'tool response');
  }

  public sendVisionFrame(base64Frame: string): void {
    if (!this.ws || !this.connected || !this.sessionReady) return;

    const message = {
      realtimeInput: {
        mediaChunks: [
          {
            mimeType: 'image/jpeg',
            data: base64Frame,
          },
        ],
      },
    };

    this.safeSend(JSON.stringify(message), 'vision frame');
  }

  /**
   * Interrupts model output and clears the local downstream audio buffer and
   * pending turn accumulators.
   *
   * NOTE: the native-audio model runs with automatic activity detection (the
   * server performs VAD and interrupts model output on user speech), so the
   * client must NOT send an explicit `activityStart` frame — the server
   * rejects it (`code=1007, Explicit activity control is not supported when
   * automatic activity detection is enabled`), which caused the live session
   * to flap in an endless reconnect loop. Barge-in is handled by flushing the
   * local playback buffer and letting the server-side VAD cut the turn.
   */
  public sendClientInterruption(): boolean {
    // No explicit activity-control frame: automatic VAD handles turn cutting.
    this.pendingModelResponse = '';
    this.pendingUserTranscript = '';
    this.emit('audio-buffer-flush');
    return true;
  }

  /**
   * Triggers barge-in cancellation logic when user speech begins.
   * Flushes local audio playback buffer, sends client cancellation frame to Gemini server,
   * and returns elapsed execution time (ms).
   */
  public triggerInterruptionCancel(): number {
    const start = performance.now();
    this.sendClientInterruption();
    return performance.now() - start;
  }

  public disconnectStream(): void {
    this.intentionalClose = true;
    this.clearReconnectTimer();
    this.stopHeartbeat();
    this.teardownSocket(1000, 'Client requested disconnect');
    this.connected = false;
    this.sessionReady = false;
    this.setConnectionState('DISCONNECTED');
  }

  public getLatency(): number {
    return this.latencyMs;
  }

  public isConnected(): boolean {
    return this.connected;
  }

  public isSessionReady(): boolean {
    return this.sessionReady;
  }

  public getConnectionState(): ConnectionState {
    return this.connectionState;
  }

  public computeRmsAmplitude(pcmBuffer: Buffer): number {
    const sampleCount = Math.floor(pcmBuffer.length / 2);
    if (sampleCount === 0) return 0;

    let sumOfSquares = 0;
    for (let i = 0; i < sampleCount; i++) {
      const sample = pcmBuffer.readInt16LE(i * 2);
      const normalised = sample / 32768;
      sumOfSquares += normalised * normalised;
    }

    return Math.sqrt(sumOfSquares / sampleCount);
  }

  private emitInteractionComplete(): void {
    if (!this.pendingUserTranscript && !this.pendingModelResponse) return;

    this.emit('interaction-complete', {
      transcriptInput: this.pendingUserTranscript,
      responseOutput: this.pendingModelResponse,
      latencyMs: this.latencyMs,
      timestamp: Date.now(),
    });

    this.pendingUserTranscript = '';
    this.pendingModelResponse = '';
  }

  private safeSend(serialized: string, context: string): void {
    if (!this.ws) return;

    if (this.ws.readyState !== WebSocket.OPEN) {
      console.warn(`[geminiLiveBridge] attempted to send ${context} while socket state is ${this.ws.readyState}; scheduling reconnect`);
      if (!this.intentionalClose) this.scheduleReconnect();
      return;
    }

    try {
      this.ws.send(serialized);
    } catch (err) {
      console.error(`[geminiLiveBridge] failed to send ${context}; socket presumed dead:`, err);
      this.connected = false;
      this.sessionReady = false;
      this.setConnectionState('ERROR');
      if (!this.intentionalClose) {
        this.scheduleReconnect();
      }
    }
  }

  private teardownSocket(code = 1000, reason = 'Closing socket'): void {
    if (!this.ws) return;
    const socket = this.ws;
    this.ws = null;
    socket.removeAllListeners();
    try {
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.close(code, reason);
      } else {
        socket.terminate();
      }
    } catch {
      try {
        socket.terminate();
      } catch {}
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.intentionalClose) return;
    if (!this.apiKey || this.apiKey.trim() === '') return;

    this.reconnectAttempts++;
    const jitterSpan = this.reconnectDelayMs * RECONNECT_JITTER_RATIO;
    const jitter = (Math.random() * 2 - 1) * jitterSpan;
    const delay = Math.max(100, Math.round(this.reconnectDelayMs + jitter));

    console.warn(`[geminiLiveBridge] connection lost (attempt ${this.reconnectAttempts}); reconnecting in ${delay}ms`);

    this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, RECONNECT_MAX_DELAY_MS);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.intentionalClose) {
        this.connectStream();
      }
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private broadcastToAllWindows(channel: string, data: unknown): void {
    try {
      const windows = BrowserWindow.getAllWindows();
      for (const win of windows) {
        if (!win.isDestroyed()) {
          win.webContents.send(channel, data);
        }
      }
    } catch (err) {
      console.error('[geminiLiveBridge] failed to broadcast to renderer windows:', err);
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.keepAliveTimer = setInterval(() => {
      if (!this.ws || !this.connected || this.ws.readyState !== WebSocket.OPEN) return;

      if (Date.now() - this.lastPongAt > STALE_CONNECTION_MS) {
        console.error(
          '[geminiLiveBridge] no pong within stale threshold; terminating socket to force reconnect',
        );
        this.teardownSocket(1006, 'Stale connection');
        if (!this.intentionalClose) {
          this.scheduleReconnect();
        }
        return;
      }

      this.lastPingSentAt = Date.now();
      try {
        this.ws.ping();
      } catch (err) {
        console.error('[geminiLiveBridge] heartbeat ping failed:', err);
        this.teardownSocket(1006, 'Ping failed');
        if (!this.intentionalClose) {
          this.scheduleReconnect();
        }
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = null;
    }
  }

  private setConnectionState(state: ConnectionState): void {
    if (state !== this.connectionState) {
      console.log(`[geminiLiveBridge] connection state: ${this.connectionState} -> ${state}`);
    }
    this.connectionState = state;
    try {
      this.emit('connection-state-change', state);
      this.broadcastToAllWindows('gemini-connection-state', state);
    } catch (err) {
      console.error('[geminiLiveBridge] failed to notify connection state change:', err);
    }
  }
}

const envApiKey = process.env.GEMINI_API_KEY ?? '';
export const geminiLiveBridge = new GeminiLiveBridge(envApiKey);
