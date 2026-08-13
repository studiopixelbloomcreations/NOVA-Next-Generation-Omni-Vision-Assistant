// ============================================================================
// NOVA GENESIS — NEW BACKEND ELECTRON ENTRY (ACTIVE)
// ============================================================================
// This is the ACTIVE Electron main process that boots ONLY the New Backend
// (New Backend/) and wires it to the EXISTING, UNCHANGED frontend through the
// existing IPC contract. It does NOT import or initialize any legacy backend
// service (src/main/services/*, the old orchestrator, task runner, etc.).
//
// The legacy backend (src/main/main.ts and src/main/services/*) is retained in
// the repository but DISABLED — it is no longer the entry point and never
// starts. See docs/NEW_BACKEND_ARCHITECTURE.md.
// ============================================================================
import 'dotenv/config';
import { app, BrowserWindow } from 'electron';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

// Load the New Backend CJS build. Dynamic require keeps TypeScript from trying
// to resolve a path outside this package's rootDir.
const loadBackend = (id: string): any => require(id);
const { NovaBackend } = loadBackend('../../New Backend/dist-cjs/index.js');

let mainWindow: BrowserWindow | null = null;
let backend: any = null;
let isQuitting = false;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    frame: true,
    backgroundColor: '#020205',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webviewTag: true,
      preload: join(__dirname, 'preload.js'),
    },
  });
  const RENDERER_HTML = existsSync(join(__dirname, '../renderer/index.html'))
    ? join(__dirname, '../renderer/index.html')
    : join(__dirname, '../renderer/src/renderer/index.html');
  if (!existsSync(RENDERER_HTML)) console.error('[nova2] renderer HTML not found', RENDERER_HTML);
  mainWindow.loadFile(RENDERER_HTML);

  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow?.hide();
    }
  });
  mainWindow.on('closed', () => { mainWindow = null; });
}

// Webview lockdown mirrors the legacy hardening (workspace-first content).
app.on('will-attach-webview', (event: Electron.Event, webPreferences: Record<string, unknown>, params: { src?: string }) => {
  delete webPreferences.preload;
  webPreferences.nodeIntegration = false;
  webPreferences.contextIsolation = true;
  webPreferences.sandbox = true;
  const src = String(params?.src ?? '');
  if (!/^https?:\/\//i.test(src) && !src.startsWith('file://')) {
    event.preventDefault();
  }
});
app.on('web-contents-created', (_event: any, contents: any) => {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
});

app.whenReady().then(async () => {
  const lock = app.requestSingleInstanceLock();
  if (!lock) { app.quit(); return; }
  try { app.setAppUserModelId('com.nova.genesis'); } catch { /* non-Windows */ }

  // Boot the New Backend (lifecycle engine runs the ordered startup).
  backend = new NovaBackend({ logLevel: process.env.NOVA_LOG_LEVEL === 'debug' ? 'debug' : 'info' });
  const ready = await backend.start();

  // Wire the New Backend onto the EXISTING frontend IPC contract (UI unchanged).
  const { wireElectron } = loadBackend('../../New Backend/dist-cjs/electron_adapter.js');
  const registered = wireElectron(backend);

  // System 30 — when the user says "ADAM, close yourself", shut down cleanly.
  backend.onCloseRequested(() => {
    isQuitting = true;
    void shutdown().finally(() => app.exit(0));
  });

  createWindow();
  console.log(`[nova2] backend ready=${ready} wiredChannels=${registered.length}`);

  if (!ready) {
    // Never claim READY prematurely.
    console.error('[nova2] backend failed to reach READY');
  }
});

let shutdownDone = false;
async function shutdown(): Promise<void> {
  if (shutdownDone) return;
  shutdownDone = true;
  isQuitting = true;
  try { if (backend) await backend.shutdown(); } catch (err) { console.error('[nova2] shutdown error', err); }
}

app.on('before-quit', () => { isQuitting = true; });
app.on('will-quit', (event) => {
  if (shutdownDone) return;
  event.preventDefault();
  void shutdown().finally(() => { app.exit(0); });
});
process.on('SIGINT', () => { void shutdown().finally(() => app.quit()); });
process.on('SIGTERM', () => { void shutdown().finally(() => app.quit()); });
app.on('window-all-closed', () => { if (isQuitting) app.quit(); });
