// src/renderer/utils/browser_bridge.ts
//
// WebSocket bridge for the pure-browser runtime. Inside Electron the renderer
// talks to the main process over IPC, so this bridge must never open a socket
// there — every method becomes an inert no-op.
type EventHandler = (payload?: any) => void;

const isElectron: boolean = (() => {
  try {
    if (typeof window === 'undefined') return false;
    const w = window as any;
    return typeof w.require === 'function' || w.process?.type === 'renderer';
  } catch {
    return false;
  }
})();

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 15000;
const OUTBOUND_QUEUE_MAX = 200;

class BrowserBridge {
  private ws: WebSocket | null = null;
  private handlers: Map<string, EventHandler[]> = new Map();
  private url: string;

  // Lazy-connect state: no socket is opened until the first on() or send.
  private started = false;
  private reconnectDelayMs = RECONNECT_BASE_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  // Outbound frames buffered while the socket is CONNECTING or reconnecting,
  // flushed in order on 'open'. Bounded: oldest frames are dropped first.
  private outbound: Array<string | ArrayBuffer> = [];
  private overflowLogged = false;
  private outageLogged = false;

  constructor(url?: string) {
    // Build dynamic WS URL from current window location to avoid hardcoded ports
    try {
      const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = `${wsProtocol}//${window.location.host}/ws`;
      this.url = url || (window as any).__GEMINI_WS_URL__ || wsUrl;
    } catch (e) {
      this.url = url || 'ws://localhost:3000/ws';
    }
  }

  private ensureStarted() {
    if (isElectron || this.started) return;
    this.started = true;
    this.connect();
  }

  private scheduleReconnect() {
    if (this.reconnectTimer !== null) return;
    // ±20% jitter so multiple tabs don't reconnect in lockstep
    const jitter = 1 + (Math.random() * 0.4 - 0.2);
    const delay = Math.round(this.reconnectDelayMs * jitter);
    this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, RECONNECT_MAX_MS);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private connect() {
    try {
      this.ws = new WebSocket(this.url);
      this.ws.binaryType = 'arraybuffer';

      this.ws.onopen = () => {
        this.reconnectDelayMs = RECONNECT_BASE_MS;
        if (this.outageLogged) {
          console.info('[browser_bridge] connection restored');
        }
        this.outageLogged = false;
        this.overflowLogged = false;
        this.flushOutbound();
        this.emitInternal('connected');
      };

      this.ws.onmessage = (ev) => {
        try {
          if (typeof ev.data === 'string') {
            this.handleJsonFrame(ev.data);
          } else {
            // raw binary audio chunk
            this.emitInternal('ai-audio-chunk', ev.data);
          }
        } catch (e) {
          console.error('BrowserBridge parse error', e);
        }
      };

      this.ws.onclose = () => {
        if (!this.outageLogged) {
          this.outageLogged = true;
          console.warn('[browser_bridge] connection lost; reconnecting with backoff');
        }
        this.emitInternal('disconnected');
        this.scheduleReconnect();
      };

      this.ws.onerror = (err) => {
        this.emitInternal('error', err);
      };
    } catch (e) {
      if (!this.outageLogged) {
        this.outageLogged = true;
        console.error('[browser_bridge] connect failed; retrying with backoff', e);
      }
      this.scheduleReconnect();
    }
  }

  private handleJsonFrame(raw: string) {
    const msg = JSON.parse(raw);
    if (msg.event && msg.payload !== undefined) {
      this.emitInternal(msg.event, msg.payload);
      return;
    }
    if (msg.event) {
      this.emitInternal(msg.event);
      return;
    }
    const sc = msg.serverContent;
    if (!sc) return;

    if (sc.outputTranscription?.text) {
      this.emitInternal('ai-text-token', sc.outputTranscription.text);
    }
    if (sc.inputTranscription?.text) {
      this.emitInternal('user-text-transcribed', sc.inputTranscription.text);
    }
    // Gemini Live delivers audio as base64 inlineData inside JSON; decode to
    // the raw PCM ArrayBuffer the app-level 'ai-audio-chunk' contract expects.
    const parts = sc.modelTurn?.parts;
    if (Array.isArray(parts)) {
      for (const part of parts) {
        const inline = part?.inlineData;
        if (inline?.data && typeof inline.data === 'string' && (inline.mimeType ?? '').startsWith('audio/')) {
          this.emitInternal('ai-audio-chunk', base64ToArrayBuffer(inline.data));
        } else if (part?.text) {
          this.emitInternal('ai-text-token', part.text);
        }
      }
    }
  }

  private flushOutbound() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const queued = this.outbound.splice(0);
    for (const frame of queued) {
      try {
        this.ws.send(frame as any);
      } catch (e) {
        console.error('BrowserBridge flush failed', e);
      }
    }
  }

  private enqueue(frame: string | ArrayBuffer) {
    if (this.outbound.length >= OUTBOUND_QUEUE_MAX) {
      this.outbound.shift();
      if (!this.overflowLogged) {
        this.overflowLogged = true;
        console.warn(`[browser_bridge] outbound queue overflow (>${OUTBOUND_QUEUE_MAX}); dropping oldest frames`);
      }
    }
    this.outbound.push(frame);
  }

  private send(frame: string | ArrayBuffer) {
    if (isElectron) return;
    this.ensureStarted();
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(frame as any);
      } catch (e) {
        console.error('BrowserBridge send failed', e);
      }
    } else {
      this.enqueue(frame);
    }
  }

  public on(event: string, cb: EventHandler) {
    const list = this.handlers.get(event) || [];
    list.push(cb);
    this.handlers.set(event, list);
    this.ensureStarted();
  }

  public off(event: string, cb: EventHandler) {
    const list = this.handlers.get(event) || [];
    this.handlers.set(event, list.filter((f) => f !== cb));
  }

  public sendRaw(obj: any) {
    this.send(typeof obj === 'string' ? obj : JSON.stringify(obj));
  }

  public sendBinary(buffer: ArrayBuffer) {
    this.send(buffer);
  }

  private emitInternal(event: string, payload?: any) {
    const list = this.handlers.get(event) || [];
    for (const h of list) h(payload);
  }
}

function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

export const browserBridge = new BrowserBridge();

export default browserBridge;
