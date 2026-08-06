// src/main/services/gemini_live_bridge.ts
import { EventEmitter } from 'events';
import { BrowserWindow } from 'electron';
import { performance } from 'perf_hooks';
import WebSocket from 'ws';

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
  private sessionReady = false;
  private connectionState: ConnectionState = 'DISCONNECTED';
  private latencyMs: number = 0;
  private lastPingSentAt: number = 0;
  private lastPongAt: number = 0;
  private keepAliveTimer: NodeJS.Timeout | null = null;
  private toolDeclarations: unknown[] = [];

  private intentionalClose = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectDelayMs = RECONNECT_BASE_DELAY_MS;

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

  public connectStream(): void {
    this.clearReconnectTimer();
    this.intentionalClose = false;

    if (this.ws && this.connected) {
      this.teardownSocket(1000, 'Reconnecting');
    }

    if (!this.apiKey) {
      console.warn('[geminiLiveBridge] GEMINI_API_KEY is undefined. Set it in .env file.');
      this.setConnectionState('ERROR');
      return;
    }

    // Validate API key format
    if (!this.apiKey.startsWith('AIzaSy')) {
      console.warn('[geminiLiveBridge] GEMINI_API_KEY does not look like a valid Google AI Studio key (should start with AIzaSy)');
    }

    // Correct endpoint: BidiGenerateContent with API key as query param
    const endpoint = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${this.apiKey}`;

    console.log('[geminiLiveBridge] Connecting to Gemini Live API...');
    this.setConnectionState('CONNECTING');
    this.ws = new WebSocket(endpoint);

    this.ws.on('open', () => {
      console.log('[geminiLiveBridge] WebSocket opened, sending setup frame');
      this.connected = true;
      this.setConnectionState('CONNECTED');

      // Properly formatted setup message per Live API spec
      // Model name MUST include "models/" prefix for BidiGenerateContent
      // Voice must be one of: Aoede, Charon, Fenrir, Kore, Puck
      const setupMessage = {
        setup: {
          model: 'models/gemini-2.5-flash-native-audio-preview-12-2025',
          generationConfig: {
            responseModalities: ['AUDIO'],
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: { voiceName: 'Kore' },
              },
            },
          },
          systemInstruction: {
            parts: [{ text: 'You are a secure assistant. Respond concisely and clearly.' }],
          },
          inputAudioTranscription: {},
          outputAudioTranscription: {},
        },
      };

      if (this.toolDeclarations.length > 0) {
        (setupMessage.setup as any).tools = this.toolDeclarations;
      }

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
        payload = JSON.parse(raw.toString());
        this.malformedFrameLogged = false;
      } catch (err) {
        if (!this.malformedFrameLogged) {
          this.malformedFrameLogged = true;
          console.error('[geminiLiveBridge] received malformed (non-JSON) frame; suppressing further malformed-frame logs until a valid frame arrives', err);
        }
        return;
      }

      const serverContent = payload?.serverContent;

      if (payload?.toolCall) {
        this.emit('tool-call', payload.toolCall);
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

      if (payload?.setupComplete) {
        console.log('[geminiLiveBridge] Setup complete - session ready');
        this.sessionReady = true;
        this.reconnectDelayMs = RECONNECT_BASE_DELAY_MS;
        this.emit('setup-complete');
      }

      // Log errors from server
      if (payload?.error) {
        console.error('[geminiLiveBridge] Server error:', payload.error);
        this.setConnectionState('ERROR');
        this.ws?.terminate();
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
      this.emit('error', err);

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

    const message = {
      realtimeInput: {
        text,
      },
    };

    this.safeSend(JSON.stringify(message), 'text message');
  }

  public sendToolResponse(functionResponses: Array<{ id: string; name: string; response: unknown }>): void {
    if (!this.ws || !this.connected) return;
    const message = {
      toolResponse: {
        functionResponses,
      },
    };
    this.safeSend(JSON.stringify(message), 'tool response');
  }

  // Vision chunk engine: send camera/desktop frames as media chunks
  public sendVisionFrame(base64Frame: string): void {
    if (!this.ws || !this.connected || !this.sessionReady) return;

    const message = {
      realtimeInput: {
        mediaChunks: [{
          mimeType: 'image/jpeg',
          data: base64Frame,
        }],
      },
    };

    this.safeSend(JSON.stringify(message), 'vision frame');
  }

  /**
   * Flushes the downstream audio buffer. Returns the elapsed time (ms) of the
   * flush event dispatch itself — synchronous listener execution time, not any
   * network round-trip. Expected to be near zero.
   */
  public triggerInterruptionCancel(): number {
    const start = performance.now();
    this.emit('audio-buffer-flush');
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

  private teardownSocket(code: number, reason: string): void {
    if (!this.ws) return;
    const socket = this.ws;
    // Null out first so the 'close' handler's reconnect logic sees intentionalClose correctly
    // and we never operate on a half-dead reference.
    this.ws = null;
    socket.removeAllListeners();
    try {
      socket.close(code, reason);
    } catch {
      socket.terminate();
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.intentionalClose) return;

    const jitterSpan = this.reconnectDelayMs * RECONNECT_JITTER_RATIO;
    const jitter = (Math.random() * 2 - 1) * jitterSpan;
    const delay = Math.max(0, Math.round(this.reconnectDelayMs + jitter));

    console.error(`[geminiLiveBridge] connection lost; reconnecting in ${delay}ms`);

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
    const windows = BrowserWindow.getAllWindows();
    for (const win of windows) {
      if (!win.isDestroyed()) {
        win.webContents.send(channel, data);
      }
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.keepAliveTimer = setInterval(() => {
      if (!this.ws || !this.connected) return;

      if (Date.now() - this.lastPongAt > STALE_CONNECTION_MS) {
        console.error('[geminiLiveBridge] no pong within stale threshold; terminating socket to force reconnect');
        // terminate() fires 'close', which drives the reconnect path.
        this.ws.terminate();
        return;
      }

      this.lastPingSentAt = Date.now();
      try {
        this.ws.ping();
      } catch (err) {
        console.error('[geminiLiveBridge] heartbeat ping failed:', err);
        this.ws.terminate();
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
    this.emit('connection-state-change', state);

    this.broadcastToAllWindows('gemini-connection-state', state);
  }
}

const envApiKey = process.env.GEMINI_API_KEY ?? '';
export const geminiLiveBridge = new GeminiLiveBridge(envApiKey);