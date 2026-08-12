// New Backend — electron_adapter.ts
// Minimal Electron wiring. Maps the New Backend onto the EXISTING frontend IPC
// contract (`src/shared/ipc_protocols.ts`) so the UI is UNCHANGED. This file is
// only imported from the Electron main process; it is Electron-safe elsewhere.
//
// It intentionally does NOT touch any frontend component — it only exposes the
// backend's capabilities through the channels the renderer already calls, plus
// a small backward-compatible `nova2:*` block.
import type { NovaBackend } from './index.js';
import { NovaIpcChannel } from './contracts/ipc.js';
import { logger } from './core/logger.js';

type ElectronLike = {
  ipcMain: {
    handle(channel: string, handler: (...args: unknown[]) => unknown): void;
    on(channel: string, handler: (e: unknown, ...args: unknown[]) => void): void;
  };
  BrowserWindow: { getAllWindows(): Array<{ isDestroyed(): boolean; webContents: { send(c: string, ...a: unknown[]): void } }> };
};

function loadElectron(): ElectronLike | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const electron = (globalThis as { require?: (m: string) => unknown }).require?.('electron');
    return electron as ElectronLike | null;
  } catch {
    return null;
  }
}

function broadcast(electron: ElectronLike | null, channel: string, payload: unknown): void {
  try {
    if (!electron) return;
    for (const win of electron.BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(channel, payload);
    }
  } catch (err) {
    logger.error('[electron_adapter] broadcast failed', { channel, error: String(err) });
  }
}

/**
 * Wire the backend to the existing Electron IPC surface. Returns the channels
 * that were registered so the host can confirm wiring.
 */
export function wireElectron(backend: NovaBackend): string[] {
  const electron = loadElectron();
  if (!electron) {
    logger.warn('[electron_adapter] not running under Electron; IPC wiring skipped');
    return [];
  }
  const { ipcMain } = electron;
  const registered: string[] = [];

  // Push backend state/activity/workspace to the renderer on change.
  const pushState = (): void => broadcast(electron, NovaIpcChannel.RUNTIME_STATE_CHANGE, backend.runtimeState());
  const pushActivity = (level: string, message: string): void =>
    broadcast(electron, NovaIpcChannel.RUNTIME_ACTIVITY, { id: `${Date.now()}`, ts: Date.now(), level, message });

  if (backend.agent) backend.agent.on('activity', (a: { level: string; message: string }) => pushActivity(a.level, a.message));
  backend.lifecycle.on('step', () => pushState());

  // --- Existing frontend invoke channels (identical names, no UI change) ---
  const handle = (channel: string, fn: (...args: unknown[]) => Promise<unknown> | unknown): void => {
    ipcMain.handle(channel, async (_e: unknown, ...args: unknown[]) => {
      try {
        return await fn(...args);
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    });
    registered.push(channel);
  };

  handle(NovaIpcChannel.TRIGGER_AUTOMATION, async (text: unknown) => {
    const result = await backend.handleRequest(String(text ?? ''), 'typed');
    return { success: result.status === 'completed', handled: 'nova2', trace: result.entry, summary: result.summary };
  });

  handle(NovaIpcChannel.RUN_TASK, async (text: unknown) => {
    const result = await backend.handleRequest(String(text ?? ''), 'typed');
    return result.entry;
  });

  handle(NovaIpcChannel.RUN_TOOL, async (name: unknown, args: unknown) => {
    if (!backend.agent) return { success: false, error: 'backend not ready' };
    const r = await backend.agent.engines.executor.execute(String(name ?? ''), (args as Record<string, unknown>) ?? {});
    return { success: r.success, payload: r.payload, error: r.error };
  });

  handle(NovaIpcChannel.LIST_CAPABILITIES, () => backend.listCapabilities());
  handle(NovaIpcChannel.TOOL_REGISTRY_VIEW, () => backend.toolRegistryView());
  handle(NovaIpcChannel.TOOL_HEALTH_REPORT, () => backend.toolRegistryView());
  handle(NovaIpcChannel.TOOL_EXEC_LOG, () => backend.ledger.recent(100));
  handle(NovaIpcChannel.MEMORY_SEARCH, async (q: unknown, k: unknown) => backend.memory.search(String(q ?? ''), Math.min(Math.max(Number(k) || 5, 1), 20)));
  handle(NovaIpcChannel.SYSTEM_INFO_REQUEST, async () => backend.environment.observe());
  handle(NovaIpcChannel.GET_RUNTIME_STATE, () => ({ state: backend.runtimeState(), activity: backend.telemetry.snapshot() }));
  handle(NovaIpcChannel.GET_BOOT_STATE, () => backend.bootState());
  handle(NovaIpcChannel.WORKSPACE_LIST, () => ({ surfaces: backend.workspace.list() }));
  handle(NovaIpcChannel.WORKSPACE_CLOSE, (_e: unknown, id: unknown) => ({ success: backend.workspace.close(String(id ?? '')) }));
  handle(NovaIpcChannel.WORKSPACE_OPEN_URL, (_e: unknown, url: unknown) => {
    const trimmed = String(url ?? '').trim();
    if (!/^https?:\/\//i.test(trimmed)) return { success: false, error: 'workspace URL must start with http(s)://' };
    const surface = backend.workspace.open({ type: 'web', title: trimmed, source: trimmed });
    return { success: true, surfaceId: surface.id };
  });

  // --- Backward-compatible additions ---
  handle(NovaIpcChannel.NB_PING, () => ({ pong: true, backend: 'nova2' }));
  handle(NovaIpcChannel.NB_INTENT, async (t: unknown) => (backend.agent ? backend.agent.engines.intent.classifyDeterministic(String(t ?? '')) : null));
  handle(NovaIpcChannel.NB_TELEMETRY, () => backend.telemetry.snapshot());
  handle(NovaIpcChannel.NB_CAPABILITIES, () => backend.listCapabilities());

  logger.info('[electron_adapter] wired New Backend to existing IPC', { channels: registered.length });
  return registered;
}

export function sendToRenderer(channel: string, payload: unknown): void {
  broadcast(loadElectron(), channel, payload);
}
