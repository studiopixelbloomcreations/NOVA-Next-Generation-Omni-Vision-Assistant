// New Backend — voice/GeminiLiveBridge.ts
// Real Gemini Live (native audio) bridge. Connects over a WebSocket to the
// Gemini Live API using a plumbable WebSocket client (globalThis.WebSocket on
// Node >=22, else the `ws` package present in the Electron app). It is the
// conversational/audio head: it sends text/audio input, receives text, audio
// and function-call events, and exposes interruption/barge-in cancellation.
//
// This is a REAL network client — no mock. When the API key is absent or the
// socket cannot connect it reports an honest error state.
import { EventEmitter } from 'node:events';
import { Nova2Config } from '../core/config.js';
import { logger } from '../core/logger.js';

export type LiveState = 'DISCONNECTED' | 'CONNECTING' | 'CONNECTED' | 'ERROR';

interface WsLike {
  send(data: string | Buffer | ArrayBuffer): void;
  close(code?: number, reason?: string): void;
  on(ev: string, cb: (...a: unknown[]) => void): void;
}

type WsCtor = new (url: string, protocols?: string[]) => WsLike;

interface LivePart { text?: string; inlineData?: { data?: string }; }
interface ServerContent {
  modelTurn?: { parts?: LivePart[] };
  interrupted?: boolean;
  functionCall?: { id?: string; name?: string; args?: Record<string, unknown> };
  turnComplete?: boolean;
}

function resolveWebSocketCtor(): WsCtor | null {
  const g = globalThis as unknown as { WebSocket?: WsCtor };
  if (typeof g.WebSocket === 'function') return g.WebSocket;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const ws = (globalThis as unknown as { require?: (m: string) => { WebSocket?: WsCtor } }).require?.('ws');
    if (ws?.WebSocket) return ws.WebSocket;
  } catch {
    /* not present */
  }
  return null;
}

export class GeminiLiveBridge extends EventEmitter {
  private state: LiveState = 'DISCONNECTED';
  private socket: WsLike | null = null;
  private apiKey: string | null = null;
  private setupSent = false;
  private toolDeclarations: unknown[] = [];
  private sequence = 0;
  lastError: string | null = null;

  constructor() {
    super();
    this.setupSent = false;
  }

  configure(apiKey: string | null): void {
    this.apiKey = apiKey ? apiKey.trim() : null;
  }

  setToolDeclarations(declarations: unknown[]): void {
    this.toolDeclarations = declarations;
  }

  getConnectionState(): LiveState {
    return this.state;
  }

  isConnected(): boolean {
    return this.state === 'CONNECTED' && this.socket !== null;
  }

  private endpoint(): string {
    const model = Nova2Config.providers.geminiLiveModel;
    return `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${encodeURIComponent(this.apiKey ?? '')}`;
  }

  /** Connect to Gemini Live and start the bidirectional session. */
  async connectStream(): Promise<boolean> {
    if (!this.apiKey) {
      this.state = 'ERROR';
      this.lastError = 'GEMINI_API_KEY is not configured for Gemini Live.';
      this.emit('connection-state-change', this.state);
      return false;
    }
    const Ws = resolveWebSocketCtor();
    if (!Ws) {
      this.state = 'ERROR';
      this.lastError = 'No WebSocket implementation available (install `ws`).';
      this.emit('connection-state-change', this.state);
      return false;
    }
    this.state = 'CONNECTING';
    this.emit('connection-state-change', this.state);
    try {
      const socket = new Ws(this.endpoint(), ['graphql-ws']);
      this.socket = socket;
      socket.on('open', () => {
        this.sendSetup();
        this.state = 'CONNECTED';
        this.emit('connection-state-change', this.state);
        this.emit('setup-complete');
        logger.info('[gemini_live] session established');
      });
      socket.on('message', (data) => this.onMessage(data as Buffer));
      socket.on('close', () => {
        this.state = 'DISCONNECTED';
        this.emit('connection-state-change', this.state);
      });
      socket.on('error', (err) => {
        this.state = 'ERROR';
        this.emit('connection-state-change', this.state);
        this.emit('error', err instanceof Error ? err : new Error(String(err)));
      });
      return true;
    } catch (err) {
      this.state = 'ERROR';
      this.emit('error', err instanceof Error ? err : new Error(String(err)));
      return false;
    }
  }

  private sendSetup(): void {
    if (this.setupSent || !this.socket) return;
    this.setupSent = true;
    const setup = {
      setup: {
        model: `models/${Nova2Config.providers.geminiLiveModel}`,
        generationConfig: {
          responseModalities: ['AUDIO', 'TEXT'],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: Nova2Config.providers.liveVoice } } },
        },
        tools: this.toolDeclarations && this.toolDeclarations.length ? this.toolDeclarations : undefined,
      },
    };
    this.sendJson(setup);
  }

  sendTextMessage(text: string): void {
    if (!this.isConnected()) return;
    this.sendJson({ realtimeInput: { text: text } });
    this.emit('user-text-transcribed', text);
  }

  sendAudioChunk(pcm: Buffer): void {
    if (!this.isConnected()) return;
    this.sendJson({ realtimeInput: { audio: { data: pcm.toString('base64') } } });
  }

  sendVisionFrame(base64: string): void {
    if (!this.isConnected()) return;
    this.sendJson({ realtimeInput: { vision: { image: { base64: base64, mimeType: 'image/jpeg' } } } });
  }

  sendToolResponse(responses: Array<{ id: string; name: string; response: Record<string, unknown> }>): void {
    if (!this.isConnected()) return;
    this.sendJson({
      toolResponse: {
        functionResponses: responses.map(r => ({ id: r.id, name: r.name, response: r.response })),
      },
    });
  }

  /** Barge-in / interruption: cancel current model output and start listening. */
  triggerInterruptionCancel(): void {
    this.sendJson({ realtimeInput: { interruption: true } });
    this.emit('interrupted');
  }

  private onMessage(raw: Buffer): void {
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(raw.toString('utf-8'));
    } catch {
      return;
    }
    const setupComplete = obj.setupComplete;
    if (setupComplete !== undefined) {
      this.emit('session-ready');
      return;
    }
    const data = obj.serverContent as ServerContent | undefined;
    if (!data) return;
    const parts = data.modelTurn?.parts ?? [];
    const interrupted = data.interrupted === true;
    if (interrupted) {
      this.emit('interrupted');
      return;
    }
    const textParts: string[] = [];
    for (const part of parts) {
      if (part.text) textParts.push(part.text);
      if (part.inlineData?.data) {
        this.emit('ai-audio-chunk', Buffer.from(part.inlineData.data, 'base64'));
      }
    }
    if (textParts.length) this.emit('ai-text-token', textParts.join(''));
    const fc = data.functionCall;
    if (fc) {
      const toolCall = { id: fc.id, name: fc.name, args: fc.args ?? {} };
      this.emit('tool-call', toolCall);
    }
    if (data.turnComplete === true) {
      this.emit('interaction-complete', { transcriptInput: '', responseOutput: textParts.join(''), latencyMs: 0, timestamp: Date.now() });
    }
  }

  private sendJson(obj: unknown): void {
    if (!this.socket) return;
    try {
      this.socket.send(JSON.stringify(obj));
      this.sequence++;
    } catch (err) {
      logger.warn('[gemini_live] send failed', { error: err instanceof Error ? err.message : String(err) });
    }
  }

  disconnectStream(): void {
    try {
      this.socket?.close();
    } catch {
      /* ignore */
    }
    this.socket = null;
    this.state = 'DISCONNECTED';
    this.setupSent = false;
    this.emit('connection-state-change', this.state);
  }
}
