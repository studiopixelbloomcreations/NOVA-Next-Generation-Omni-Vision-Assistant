import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';

// Secure IPC surface exposed to the renderer.
//
// - Only channels in the allowlists below are reachable; anything else is
//   ignored (defense in depth alongside the main-process IPC firewall).
// - Handlers are tracked in a Map (not keyed by stringified function source),
//   so `off` reliably removes listeners without leaking.
// - The raw ipcRenderer is never exposed to the page.

const EVENT_ALLOWLIST = new Set<string>([
  'nova-ipc:boot-lifecycle',
  'nova-sys:voice-state-change',
  'nova-ui:context-chip-update',
  'nova-sys:user-waveform-input',
  'nova-sys:speech-text-transcribed',
  'nova-sys:audio-buffer-flush',
  'nova-sys:telemetry-update',
  'nova-sys:gemini-setup-complete',
  'nova-sys:dream-mode-start',
  'nova-sys:dream-mode-complete',
  'nova-sys:mode-changed',
  'ai-audio-chunk',
  'ai-amplitude',
  'ai-text-token',
  'agent-progress-update',
  'agent-tool-created',
  'agent-tool-synthesis-phase',
  'agent-tool-synthesis-steps',
  'agent-tool-approval-request',
  'wake-word-detected',
  'nova-sys:runtime-state-change',
  'nova-sys:runtime-activity',
  'nova-sys:mic-state-change',
  'nova-sys:mic-toggle-request',
  'nova-sys:workspace-update',
]);

const SEND_ALLOWLIST = new Set<string>([
  'nova-ui:hud-visibility-req',
  'user-audio-chunk',
  'user-speaking-active',
  'camera-frame',
  // Mic capture-state confirmation (separate from VAD speech activity).
  'nova-sys:mic-capture-active',
  'nova-sys:mic-capture-error',
]);

const INVOKE_ALLOWLIST = new Set<string>([
  'nova-act:trigger-automation',
  'nova-db:get-knowledge-nodes',
  'nova-db:get-ledger-entries',
  'nova-db:vector-search',
  'nova-labs:life-replay-timeline',
  'nova-labs:intent-prediction',
  'nova-db:tool-registry-view',
  'nova-db:tool-health-report',
  'nova-db:tool-toggle',
  'nova-act:run-tool',
  'nova-act:run-task',
  'nova-db:list-capabilities',
  'nova-sys:system-info',
  'nova-sys:clipboard-read',
  'nova-sys:clipboard-write',
  'nova-db:audit-recent',
  'nova-sys:notify',
  'nova-db:memory-search',
  'nova-act:tool-approve',
  'nova-act:tool-reject',
  'nova-db:tool-exec-log',
  'nova-db:get-boot-state',
  'nova-db:get-runtime-state',
  'nova-act:mic-toggle',
  'nova-db:mic-diagnostic',
  'nova-db:mic-discover',
  'nova-act:mic-set-muted',
  'nova-db:get-mic-state',
  'nova-db:workspace-list',
  'nova-act:workspace-close',
  'nova-act:workspace-open-url',
]);

// Handlers use the Electron ipcRenderer convention `(event, payload)`. The
// wrapper MUST forward both arguments: forwarding only `payload` shifts every
// pushed event by one argument, so renderer handlers receive `event=payload`
// and `payload=undefined` — producing broken state (e.g. transcript text that
// renders as "NaN" from `undefined + undefined`) and making the whole UI look
// like a static mock even though the main process is alive and pushing.
type Listener = (event: IpcRendererEvent, payload: any) => void;
const handlerMap = new Map<string, Map<Listener, (event: IpcRendererEvent, payload: any) => void>>();

const novaIpc = {
  on(channel: string, listener: Listener): void {
    if (!EVENT_ALLOWLIST.has(channel)) {
      console.warn(`[preload] blocked subscription to unauthorized channel: ${channel}`);
      return;
    }
    let channelMap = handlerMap.get(channel);
    if (!channelMap) {
      channelMap = new Map();
      handlerMap.set(channel, channelMap);
    }
    if (channelMap.has(listener)) return;
    const wrapped = (_event: IpcRendererEvent, payload: any) => listener(_event, payload);
    channelMap.set(listener, wrapped);
    ipcRenderer.on(channel, wrapped);
  },

  removeListener(channel: string, listener: Listener): void {
    const channelMap = handlerMap.get(channel);
    if (!channelMap) return;
    const wrapped = channelMap.get(listener);
    if (wrapped) {
      ipcRenderer.removeListener(channel, wrapped);
      channelMap.delete(listener);
    }
  },

  send(channel: string, ...args: any[]): void {
    if (!SEND_ALLOWLIST.has(channel)) {
      console.warn(`[preload] blocked send on unauthorized channel: ${channel}`);
      return;
    }
    ipcRenderer.send(channel, ...args);
  },

  invoke(channel: string, ...args: any[]): Promise<any> {
    if (!INVOKE_ALLOWLIST.has(channel)) {
      return Promise.reject(new Error(`Unauthorized IPC channel: ${channel}`));
    }
    return ipcRenderer.invoke(channel, ...args);
  },

  /** Convenience for binary audio chunks. */
  sendBinary(channel: string, buffer: Uint8Array): void {
    if (channel !== 'user-audio-chunk') {
      console.warn(`[preload] blocked binary send on unauthorized channel: ${channel}`);
      return;
    }
    ipcRenderer.send(channel, buffer);
  },
};

contextBridge.exposeInMainWorld('__nova_ipc__', novaIpc);
contextBridge.exposeInMainWorld('__is_electron__', true);

export {};
