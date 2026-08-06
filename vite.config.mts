import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { WebSocketServer, WebSocket as WsClient } from 'ws';
import dotenv from 'dotenv';

// Load .env into process.env for dev server (so GEMINI_API_KEY is available)
dotenv.config();

const GEMINI_LIVE_ENDPOINT =
  'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';

// Must match the model used by the Electron main-process bridge
// (src/main/services/gemini_live_bridge.ts).
const GEMINI_LIVE_MODEL = 'models/gemini-2.5-flash-native-audio-preview-12-2025';

// Setup frame sent on behalf of browser clients (they never send their own —
// the renderer only emits realtimeInput frames). Mirrors the main-process bridge.
const GEMINI_SETUP_MESSAGE = JSON.stringify({
  setup: {
    model: GEMINI_LIVE_MODEL,
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
});

// Live WebSocket gateway for the pure-browser runtime.
//
// The browser client (browser_bridge.ts) connects to ws://<host>/ws. This dev
// server accepts that connection and bridges it to the official Gemini Live API,
// injecting the server-side GEMINI_API_KEY so it is never exposed to the client.
//
// NOTE: this MUST live inside a plugin's `configureServer` hook. A root-level
// `configureServer` on the Vite config object is silently ignored, which is why
// the previous inline version never actually ran.
function geminiWsProxyPlugin(): Plugin {
  return {
    name: 'gemini-ws-proxy',
    configureServer(server) {
      const httpServer = server.httpServer;
      if (!httpServer) return;

      // Vite types httpServer as a possible Http2 server; ws only accepts a
      // classic http.Server, which is what the dev server actually provides.
      const wss = new WebSocketServer({ server: httpServer as any, path: '/ws' });

      wss.on('connection', (clientSocket) => {
        const apiKey = process.env.GEMINI_API_KEY ?? '';
        if (!apiKey) {
          try {
            clientSocket.send(
              JSON.stringify({ event: 'error', payload: 'GEMINI_API_KEY not set on dev server' })
            );
          } catch {}
          clientSocket.close();
          return;
        }

        if (!apiKey.startsWith('AIzaSy')) {
          console.warn('[gemini-ws-proxy] GEMINI_API_KEY does not look like a standard Google AI Studio key; Gemini Live may reject the connection.');
        }

        const geminiEndpoint = `${GEMINI_LIVE_ENDPOINT}?key=${apiKey}`;
        let remote: WsClient | null = null;
        try {
          remote = new WsClient(geminiEndpoint);
        } catch (err) {
          console.error('[gemini-ws-proxy] Failed to create remote websocket', err);
          try {
            clientSocket.send(JSON.stringify({ event: 'remote-error', payload: String(err) }));
          } catch {}
          clientSocket.close();
          return;
        }

        // Buffer client frames that arrive before the upstream socket is open,
        // then flush them once Gemini is ready. Frame kind (text vs binary) is
        // preserved through the queue.
        let remoteOpen = false;
        let clientSentSetup = false;
        const pending: Array<{ data: Buffer | ArrayBuffer | Buffer[]; binary: boolean }> = [];

        const isSetupFrame = (data: Buffer | ArrayBuffer | Buffer[], binary: boolean): boolean => {
          if (binary) return false;
          try {
            const parsed = JSON.parse(Buffer.isBuffer(data) ? data.toString('utf8') : String(data));
            return parsed && typeof parsed === 'object' && 'setup' in parsed;
          } catch {
            return false;
          }
        };

        const safeSendToClient = (data: unknown, binary = false) => {
          if (clientSocket.readyState !== clientSocket.OPEN) return;
          try {
            clientSocket.send(data as any, { binary });
          } catch (e) {
            console.error('[gemini-ws-proxy] forward to client failed', e);
          }
        };

        const safeSendToRemote = (data: Buffer | ArrayBuffer | Buffer[], binary: boolean) => {
          if (isSetupFrame(data, binary)) clientSentSetup = true;
          if (!remote || !remoteOpen) {
            pending.push({ data, binary });
            return;
          }
          try {
            remote.send(data as any, { binary });
          } catch (e) {
            console.error('[gemini-ws-proxy] forward to remote failed', e);
          }
        };

        const closeRemote = () => {
          if (!remote) return;
          try {
            if (remote.readyState === remote.CONNECTING) {
              remote.terminate();
            } else if (remote.readyState === remote.OPEN) {
              remote.close();
            }
          } catch {}
        };

        remote.on('open', () => {
          remoteOpen = true;
          safeSendToClient(JSON.stringify({ event: 'connected' }));
          // Browser clients don't send their own setup frame — inject one that
          // mirrors the main-process bridge, before any buffered realtimeInput.
          if (!clientSentSetup && !pending.some((p) => isSetupFrame(p.data, p.binary))) {
            try {
              remote!.send(GEMINI_SETUP_MESSAGE);
            } catch (e) {
              console.error('[gemini-ws-proxy] setup injection failed', e);
            }
          }
          for (const { data, binary } of pending.splice(0)) {
            try {
              remote!.send(data as any, { binary });
            } catch (e) {
              console.error('[gemini-ws-proxy] flush to remote failed', e);
            }
          }
        });

        remote.on('message', (data, isBinary) => {
          // Gemini Live frequently delivers JSON inside binary frames; the
          // browser bridge dispatches on frame kind, so re-classify: anything
          // that parses as JSON goes out as text, everything else as binary.
          if (!isBinary) {
            safeSendToClient(data, false);
            return;
          }
          const buf = Array.isArray(data)
            ? Buffer.concat(data)
            : Buffer.isBuffer(data)
              ? data
              : Buffer.from(data as ArrayBuffer);
          if (buf.length > 0 && (buf[0] === 0x7b || buf[0] === 0x5b)) {
            const text = buf.toString('utf8');
            try {
              JSON.parse(text);
              safeSendToClient(text, false);
              return;
            } catch {}
          }
          safeSendToClient(buf, true);
        });

        remote.on('close', () => {
          safeSendToClient(JSON.stringify({ event: 'remote-closed' }));
          try {
            clientSocket.close();
          } catch {}
        });

        remote.on('error', (err) => {
          console.error('[gemini-ws-proxy] Remote socket error', err);
          safeSendToClient(JSON.stringify({ event: 'remote-error', payload: String(err) }));
          closeRemote();
        });

        clientSocket.on('error', (err) => {
          console.error('[gemini-ws-proxy] Client socket error', err);
          closeRemote();
        });

        clientSocket.on('message', (msg, isBinary) => {
          safeSendToRemote(msg as any, isBinary);
        });

        clientSocket.on('close', () => {
          closeRemote();
        });
      });
    },
  };
}

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss(), geminiWsProxyPlugin()],
  base: './',
  server: {
    port: 8080,
    watch: {
      ignored: [
        '**/dist/**',
        '**/dist_electron/**',
        '**/node_modules/**',
        '**/*.db*',
        '**/*.log',
        '**/interaction_ledger.db*',
        '**/knowledge_graph.db*',
        '**/electron_run.log',
      ],
    },
  },
  build: {
    outDir: 'dist/renderer',
    emptyOutDir: true,
  },
});