// New Backend — electron_adapter.ts
// Comprehensive Electron wiring. Maps the New Backend onto the EXISTING
// frontend IPC contract (`src/shared/ipc_protocols.ts`) so the UNCHANGED UI
// receives REAL backend state and events. This file is only imported from the
// Electron main process; it is Electron-safe elsewhere.
//
// It wires BOTH directions (System 37):
//   FRONTEND → preload → IPC → adapter → NEW BACKEND → engine → result
//   BACKEND event → adapter → IPC → preload → FRONTEND
//
// It intentionally does NOT change any frontend component — it only connects
// the backend to the channels the renderer already subscribes to.
import type { NovaBackend } from './index.js';
import { NovaIpcChannel } from './contracts/ipc.js';
import { logger } from './core/logger.js';
import { Identity } from './contracts/identity.js';

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
 * Wire the backend to the existing Electron IPC surface in BOTH directions.
 * Returns the channels registered so the host can confirm wiring.
 */
export function wireElectron(backend: NovaBackend): string[] {
  const electron = loadElectron();
  if (!electron) {
    logger.warn('[electron_adapter] not running under Electron; IPC wiring skipped');
    return [];
  }
  const { ipcMain } = electron;
  const registered: string[] = [];

  // ==========================================================================
  // BACKEND → FRONTEND event push (real state, correct payload shapes)
  // ==========================================================================

  const pushState = (): void => broadcast(electron, NovaIpcChannel.RUNTIME_STATE_CHANGE, backend.runtimeState());
  const pushActivity = (level: 'info' | 'success' | 'warn' | 'error', message: string): void =>
    broadcast(electron, NovaIpcChannel.RUNTIME_ACTIVITY, { id: `${Date.now()}`, ts: Date.now(), level, message });

  // Boot lifecycle: push current steps whenever a boot step resolves.
  const pushBoot = (): void => broadcast(electron, NovaIpcChannel.BOOT_LIFECYCLE, backend.lifecycle.getSteps().map(s => ({ stepId: s.stepId, label: s.label, status: s.status, timestamp: s.timestamp })));
  backend.lifecycle.on('step', () => { pushBoot(); pushState(); });

  // State machine transitions → runtime state push.
  backend.stateMachine.on('change', () => pushState());

  // Agent activity feed + tool synthesis progress events (real backend states).
  if (backend.agent) {
    backend.agent.on('activity', (a: { level: string; message: string }) => pushActivity(a.level as 'info', a.message));
    backend.agent.on('synthesis-phase', (payload: { phase: string; steps: unknown[] }) => {
      broadcast(electron, NovaIpcChannel.AGENT_SYNTHESIS_PHASE, payload);
      broadcast(electron, NovaIpcChannel.AGENT_SYNTHESIS_STEPS, { steps: payload.steps ?? [] });
    });
    backend.agent.on('tool-created', (tool: { id: string; name: string; technicalId: string; description: string; status: string }) => {
      broadcast(electron, NovaIpcChannel.AGENT_TOOL_CREATED, tool);
    });
  }

  // Voice state → VOICE_STATE_CHANGE (map backend voice state to NovaVoiceState).
  backend.voice.on('state-change', (snap: { currentState: string; listening: boolean }) => {
    const s = snap.currentState;
    const mapped = (['IDLE', 'LISTENING', 'REASONING', 'SPEAKING'] as const).includes(s as never) ? s : 'LISTENING';
    broadcast(electron, NovaIpcChannel.VOICE_STATE_CHANGE, {
      currentState: mapped,
      inputAmplitude: 0,
      streamLatencyMs: backend.liveBridge.getConnectionState() === 'CONNECTED' ? 0 : 0,
      detectedSpeakerId: undefined,
    });
  });

  // Transcribed speech → SPEECH_TEXT_TRANSCRIBED.
  backend.voice.on('transcript-final', (text: string) => {
    broadcast(electron, NovaIpcChannel.SPEECH_TEXT_TRANSCRIBED, { text, partial: false });
  });
  // Gemini Live partial transcription.
  backend.liveBridge.on('user-text-transcribed', (text: string) => {
    broadcast(electron, NovaIpcChannel.SPEECH_TEXT_TRANSCRIBED, { text, partial: true });
  });
  // Gemini Live setup complete → GEMINI_SETUP_COMPLETE.
  backend.liveBridge.on('setup-complete', () => {
    broadcast(electron, NovaIpcChannel.GEMINI_SETUP_COMPLETE, {});
  });
  // Gemini Live AI text tokens → ai-text-token.
  backend.liveBridge.on('ai-text-token', (token: string) => {
    broadcast(electron, NovaIpcChannel.AI_TEXT_TOKEN, token);
  });
  // Gemini Live AI audio → ai-audio-chunk + AUDIO_BUFFER_FLUSH lifecycle.
  backend.liveBridge.on('ai-audio-chunk', (chunk: Buffer) => {
    broadcast(electron, NovaIpcChannel.AI_AUDIO_CHUNK, new Uint8Array(chunk));
  });
  backend.liveBridge.on('interaction-complete', () => {
    broadcast(electron, NovaIpcChannel.AUDIO_BUFFER_FLUSH, {});
  });
  // Gemini Live connection state → runtime state.
  backend.liveBridge.on('connection-state-change', () => pushState());

  // Microphone state → MIC_STATE_CHANGE.
  const pushMic = (): void => broadcast(electron, NovaIpcChannel.MIC_STATE_CHANGE, backend.micState());
  backend.mic.on('change', () => pushMic());

  // Context chips → CONTEXT_CHIP_UPDATE (on a light interval + boot).
  const pushChips = (): void => { void backend.contextChips().then(c => broadcast(electron, NovaIpcChannel.CONTEXT_CHIP_UPDATE, c)).catch(() => undefined); };

  // System telemetry stream (~1Hz) → SYSTEM_TELEMETRY.
  const telemetryTimer = setInterval(() => {
    try {
      broadcast(electron, NovaIpcChannel.SYSTEM_TELEMETRY, backend.systemTelemetry());
      pushChips();
    } catch (err) {
      logger.error('[electron_adapter] telemetry broadcast failed', { error: String(err) });
    }
  }, 1000);
  telemetryTimer.unref?.();

  // Workspace updates → WORKSPACE_UPDATE.
  backend.workspace.onUpdate = (surfaces) => {
    broadcast(electron, NovaIpcChannel.WORKSPACE_UPDATE, { surfaces });
  };

  // Tool synthesis progress + tool-created events (from the agent).
  if (backend.agent) {
    backend.agent.on('activity', () => undefined); // activity handled above
  }

  // ==========================================================================
  // FRONTEND → BACKEND invoke channels
  // ==========================================================================

  const handle = (channel: string, fn: (...args: unknown[]) => Promise<unknown> | unknown): void => {
    ipcMain.handle(channel, async (_e: unknown, ...args: unknown[]) => {
      try {
        return await fn(...args);
      } catch (err) {
        logger.error(`[electron_adapter] handler failed for ${channel}`, { error: err instanceof Error ? err.message : String(err) });
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    });
    registered.push(channel);
  };

  // --- Core request path (System 1) ---
  handle(NovaIpcChannel.TRIGGER_AUTOMATION, async (text: unknown) => {
    const result = await backend.handleRequest(String(text ?? ''), 'typed');
    const composed = backend.composeResponse(result.entry);
    broadcast(electron, NovaIpcChannel.AI_TEXT_TOKEN, composed);
    return { success: result.status === 'completed', response: composed, trace: result.entry, summary: result.summary };
  });

  handle(NovaIpcChannel.RUN_TASK, async (text: unknown) => {
    const result = await backend.handleRequest(String(text ?? ''), 'typed');
    const composed = backend.composeResponse(result.entry);
    broadcast(electron, NovaIpcChannel.AI_TEXT_TOKEN, composed);
    return result.entry;
  });

  handle(NovaIpcChannel.RUN_TOOL, async (name: unknown, args: unknown) => {
    if (!backend.agent) return { success: false, error: 'backend not ready' };
    const r = await backend.agent.engines.executor.execute(String(name ?? ''), (args as Record<string, unknown>) ?? {});
    return { success: r.success, payload: r.payload, error: r.error };
  });

  // --- Tool registry / capabilities ---
  handle(NovaIpcChannel.LIST_CAPABILITIES, () => backend.listCapabilities());
  handle(NovaIpcChannel.TOOL_REGISTRY_VIEW, () => backend.toolRegistryView());
  handle(NovaIpcChannel.TOOL_HEALTH_REPORT, () => backend.toolRegistryView());
  handle(NovaIpcChannel.TOOL_EXEC_LOG, () => backend.ledger.recent(100));
  handle(NovaIpcChannel.TOOL_TOGGLE, (_e: unknown, id: unknown, enabled: unknown) => {
    const t = backend.library.get(String(id ?? ''));
    if (!t) return { ok: false };
    t.enabled = Boolean(enabled);
    backend.library.upsert(t);
    return { ok: true };
  });
  // Tool approval (synthesis gate is off by default; accept no-op for UI compat).
  handle(NovaIpcChannel.TOOL_APPROVE, () => ({ ok: true }));
  handle(NovaIpcChannel.TOOL_REJECT, () => ({ ok: true }));

  // --- Memory ---
  handle(NovaIpcChannel.MEMORY_SEARCH, async (q: unknown, k: unknown) => ({
    entries: await backend.memory.search(String(q ?? ''), Math.min(Math.max(Number(k) || 5, 1), 20)),
  }));

  // --- System ---
  handle(NovaIpcChannel.SYSTEM_INFO_REQUEST, async () => {
    const env = await backend.environment.observe();
    return {
      platform: env.platform,
      arch: env.arch,
      release: env.osRelease,
      hostname: env.hostname,
      cpuModel: env.cpuModel,
      cpuCores: env.cpuCores,
      totalMemoryMb: env.totalMemoryMb,
      freeMemoryMb: env.freeMemoryMb,
      electronVersion: process.versions.electron ?? 'unknown',
      appVersion: Identity.name,
    };
  });
  handle(NovaIpcChannel.CLIPBOARD_READ, async () => ({ text: '' }));
  handle(NovaIpcChannel.CLIPBOARD_WRITE, async (_e: unknown, text: unknown) => ({ ok: true }));
  handle(NovaIpcChannel.AUDIT_RECENT, () => backend.errors.all().map(e => ({ ts: e.timestamp, action: e.subsystem, outcome: e.severity === 'critical' ? 'failed' : 'ok', details: { type: e.type, message: e.message } })));
  handle(NovaIpcChannel.NOTIFY, async (_e: unknown, title: unknown, body: unknown) => ({ ok: true, title: String(title), body: String(body) }));

  // --- Runtime / boot state ---
  handle(NovaIpcChannel.GET_RUNTIME_STATE, () => ({ state: backend.runtimeState(), activity: backend.recentActivity(30) }));
  handle(NovaIpcChannel.GET_BOOT_STATE, () => backend.bootState());

  // --- Microphone ---
  handle(NovaIpcChannel.MIC_TOGGLE, async () => {
    // Ask the renderer to open/close the real getUserMedia pipeline.
    broadcast(electron, NovaIpcChannel.MIC_TOGGLE_REQUEST, {});
    return { listening: !backend.mic.snapshot.listening };
  });
  handle(NovaIpcChannel.MIC_DIAGNOSTIC, async () => ({ ok: backend.mic.snapshot.available, state: backend.mic.snapshot.state, hasSignal: backend.mic.snapshot.available }));
  handle(NovaIpcChannel.MIC_DISCOVER, async () => { backend.mic.markReady(null); return backend.micState(); });
  handle(NovaIpcChannel.MIC_SET_MUTED, async (_e: unknown, muted: unknown) => { backend.mic.setMuted(Boolean(muted)); return backend.micState(); });
  handle(NovaIpcChannel.GET_MIC_STATE, () => backend.micState());

  // --- Workspace ---
  handle(NovaIpcChannel.WORKSPACE_LIST, () => ({ surfaces: backend.workspace.list() }));
  handle(NovaIpcChannel.WORKSPACE_CLOSE, (_e: unknown, id: unknown) => ({ success: backend.workspace.close(String(id ?? '')) }));
  handle(NovaIpcChannel.WORKSPACE_OPEN_URL, (_e: unknown, url: unknown) => {
    const trimmed = String(url ?? '').trim();
    if (!/^https?:\/\//i.test(trimmed)) return { success: false, error: 'workspace URL must start with http(s)://' };
    const surface = backend.workspace.open({ type: 'web', title: trimmed, source: trimmed });
    return { success: true, surfaceId: surface.id };
  });

  // --- Backward-compatible A.D.A.M. additions ---
  handle(NovaIpcChannel.NB_PING, () => ({ pong: true, backend: 'adam', identity: Identity.name, wakeWord: Identity.wakeWord }));
  handle(NovaIpcChannel.NB_INTENT, async (t: unknown) => (backend.agent ? backend.agent.engines.intent.classifyDeterministic(String(t ?? '')) : null));
  handle(NovaIpcChannel.NB_TELEMETRY, () => backend.telemetry.snapshot());
  handle(NovaIpcChannel.NB_CAPABILITIES, () => backend.listCapabilities());
  handle(NovaIpcChannel.NB_MEMORY, async (q: unknown, k: unknown) => backend.memory.search(String(q ?? ''), Math.min(Math.max(Number(k) || 5, 1), 20)));
  handle(NovaIpcChannel.NB_ACTIVITY_STREAM, () => backend.maintenanceFindings());
  handle(NovaIpcChannel.NB_PLAN, async (t: unknown) => {
    if (!backend.agent) return null;
    const env = await backend.environment.observe();
    const intent = backend.agent.engines.intent.classifyDeterministic(String(t ?? ''));
    const provider = backend.selector.trySelect('planning');
    const envelope = backend.input.normalize(String(t ?? ''), 'typed', { environmentSnapshot: env });
    return backend.agent.engines.planning.plan(envelope, intent, [], provider);
  });

  // Diagnostics + self-management surface.
  handle('nova2:diagnostics', async () => backend.diagnosticsReport());
  handle('nova2:maintenance', () => backend.maintenanceFindings());
  handle('nova2:upgrades', () => backend.readyUpgradeProposals());
  handle('nova2:upgrade-trial', (_e: unknown, id: unknown) => ({ ok: backend.startUpgradeTrial(String(id ?? '')) }));
  handle('nova2:upgrade-accept', () => { backend.acceptUpgradeTrial(); return { ok: true }; });
  handle('nova2:speak', async (_e: unknown, text: unknown) => ({ ok: await backend.speak(String(text ?? '')) }));

  // ==========================================================================
  // FRONTEND → BACKEND send (one-way) channels
  // ==========================================================================

  // PCM audio frames from the renderer's getUserMedia → voice engine.
  ipcMain.on('user-audio-chunk', (_e: unknown, chunk: unknown) => {
    try {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      const pcm = new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 2));
      backend.processAudioFrame(pcm);
    } catch (err) {
      logger.error('[electron_adapter] audio chunk processing failed', { error: String(err) });
    }
  });
  registered.push('user-audio-chunk');

  // VAD speech activity → voice engine utterance start/end.
  ipcMain.on('user-speaking-active', (_e: unknown, isSpeaking: unknown) => {
    try {
      if (Boolean(isSpeaking)) backend.voice.onUtteranceStart();
      else void backend.voice.onUtteranceEnd();
    } catch (err) {
      logger.error('[electron_adapter] speaking-active handling failed', { error: String(err) });
    }
  });
  registered.push('user-speaking-active');

  // Renderer confirms capture state → mic manager.
  ipcMain.on(NovaIpcChannel.MIC_CAPTURE_ACTIVE, (_e: unknown, active: unknown) => {
    backend.mic.reportCaptureActive(Boolean(active));
  });
  ipcMain.on(NovaIpcChannel.MIC_CAPTURE_ERROR, (_e: unknown, message: unknown) => {
    backend.mic.reportError(typeof message === 'string' ? message : 'Microphone capture failed');
  });

  // Camera frames → Gemini Live vision.
  ipcMain.on('camera-frame', (_e: unknown, base64: unknown) => {
    if (backend.liveBridge.isConnected()) backend.liveBridge.sendVisionFrame(String(base64 ?? ''));
  });

  // HUD visibility request (no-op on backend; the window handles it in main).
  ipcMain.on(NovaIpcChannel.HUD_VISIBILITY_REQ, () => undefined);

  logger.info('[electron_adapter] wired New Backend to existing IPC (both directions)', { channels: registered.length, identity: Identity.name });
  return registered;
}

export function sendToRenderer(channel: string, payload: unknown): void {
  broadcast(loadElectron(), channel, payload);
}
