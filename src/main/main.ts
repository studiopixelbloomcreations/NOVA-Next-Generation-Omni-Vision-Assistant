import 'dotenv/config';
import { app, BrowserWindow, ipcMain, screen, desktopCapturer, Tray, Menu, nativeImage } from 'electron';
import { join } from 'path';
import { existsSync } from 'fs';
import { randomUUID } from 'crypto';
import {
  NovaIpcChannel,
  IVoiceStatePayload,
  IContextChipPayload,
  ISystemTelemetryPayload,
} from '../shared/ipc_protocols';
import { screenCapturer } from './ingestors/screen_capturer';
import { voiceProcessor } from './ingestors/voice_processor';
import { wakeWordDetector } from './ingestors/wake_word_detector';
import { whisperLiveBridge } from './services/whisper_live_bridge';
import { contextEngine } from './services/context_engine';
import { geminiLiveBridge } from './services/gemini_live_bridge';
import { agentOrchestrator } from './services/agent_orchestrator';
import { interactionLedger } from './db/sqlite_adapter';
import { graphEngine } from './db/graph_engine';
import { dreamMode } from './services/dream_mode';
import { MeetingMode } from './services/specialized_modes/meeting_mode';
import { LiveCodingMode } from './services/specialized_modes/live_coding_mode';
import { CreativeStudio } from './services/specialized_modes/creative_studio';
import { lifeReplay } from './services/life_replay';
import { intentForecaster } from './services/intent_forecaster';
import { PiiSanitizer } from './utils/security';
import { ipcFirewall } from './services/ipc_firewall';
import { SecretStore } from './services/secret_store';
import { logger } from './core/logger';
import { NovaConfig } from './core/config';
import { auditLogger } from './services/audit_logger';
import { windowsIntegration } from './services/windows_integration';
import { geminiProvider } from './services/ai_provider';
import { taskRouter } from './services/task_router';
import { memoryEngine } from './services/memory_engine';
import { aiProviderRegistry } from './services/ai_provider';
import { runtimeState } from './services/runtime_state';
import { pythonRuntime } from './services/python_runtime';
import { micManager } from './services/mic_manager';
import { personalityEngine } from './services/personality_engine';

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;

// Branded app/tray icon (dev: <root>/build; packaged: bundled via `files`).
const APP_ICON_PATH = join(__dirname, '..', '..', 'build', 'icon.png');

function loadAppIcon(): Electron.NativeImage | null {
  try {
    if (existsSync(APP_ICON_PATH)) {
      return nativeImage.createFromPath(APP_ICON_PATH);
    }
  } catch {
    /* fall back */
  }
  return null;
}
let isQuitting = false;
let voiceIngestionMarked = false;
let telemetryTimer: NodeJS.Timeout | null = null;
let latestChips: IContextChipPayload = { chips: [] };
let localWhisperActive = false;
// When Gemini Live itself resolves a spoken turn by calling a tool (tool-call
// events), NOVA Core must NOT run the capability bridge again for the same
// transcript — that would double-execute the action. The flag is set when a
// tool-call fires and consumed by the next interaction-complete.
let voiceTurnHandledByToolCall = false;
const meetingMode = new MeetingMode();
const liveCodingMode = new LiveCodingMode();
const creativeStudio = new CreativeStudio();

interface IBootStep {
  stepId: string;
  label: string;
  status: 'pending' | 'active' | 'completed' | 'failed';
  timestamp: number;
}

const bootSteps: IBootStep[] = [
  { stepId: '1', label: 'Database Initialization', status: 'pending', timestamp: 0 },
  { stepId: '2', label: 'Voice Ingestion Online', status: 'pending', timestamp: 0 },
  { stepId: '3', label: 'Knowledge Graph Online', status: 'pending', timestamp: 0 },
  { stepId: '4', label: 'Gemini Live Connected', status: 'pending', timestamp: 0 },
];

// Global safety nets: process-wide unhandled rejections and exceptions are
// logged cleanly without causing silent desktop app crashes.
process.on('unhandledRejection', (reason: unknown) => {
  logger.error('unhandled promise rejection', {
    reason: reason instanceof Error ? reason.stack || reason.message : String(reason),
  });
});

process.on('uncaughtException', (err: Error) => {
  logger.error('uncaught exception', { stack: err.stack || err.message });
});

// ---------------------------------------------------------------------------
// Bootstrapping: secrets, audit trail, logging
// ---------------------------------------------------------------------------

function bootstrapSecrets(): void {
  try {
    const secretStore = new SecretStore(NovaConfig.paths.vaultPath);
    const geminiKey = secretStore.get('GEMINI_API_KEY');
    const groqKey = secretStore.get('GROQ_API_KEY');
    const picovoiceKey = secretStore.get('PICOVOICE_ACCESS_KEY');

    // API keys are pushed into the providers directly — never written into
    // process.env — so no child process (ffmpeg, Python, PowerShell) can ever
    // inherit them. The wake-word detector is the one exception: it reads
    // PICOVOICE_ACCESS_KEY from the environment, and every spawn is scrubbed.
    if (geminiKey) {
      geminiLiveBridge.setApiKey(geminiKey);
      geminiProvider.setApiKey(geminiKey);
      memoryEngine.setEmbeddingApiKey(geminiKey);
    }
    if (groqKey || geminiKey) {
      aiProviderRegistry.configureSecrets({
        gemini: geminiKey,
        groq: groqKey,
      });
    }
    if (picovoiceKey) {
      process.env.PICOVOICE_ACCESS_KEY = picovoiceKey;
    }
    logger.info('[boot] secrets resolved', {
      gemini: !!geminiKey,
      groq: !!groqKey,
      picovoice: !!picovoiceKey,
    });
  } catch (err) {
    logger.error('[boot] secret bootstrap failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function bootstrapAudit(): void {
  try {
    auditLogger.record({ action: 'app.boot', outcome: 'ok', details: { pid: process.pid } });
    logger.auditSink = event => auditLogger.record(event);
    logger.configure({
      level: process.env.NOVA_LOG_LEVEL === 'debug' ? 'debug' : 'info',
      filePath: NovaConfig.paths.auditLog,
    });
  } catch (err) {
    logger.error('[boot] audit bootstrap failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ---------------------------------------------------------------------------
// Renderer communication helpers
// ---------------------------------------------------------------------------

function sendToRenderer(channel: string, ...args: unknown[]): void {
  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(channel, ...args);
    }
  } catch (err) {
    logger.error(`failed to send to channel ${channel}`, {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function broadcastBootSteps(): void {
  sendToRenderer('nova-ipc:boot-lifecycle', [...bootSteps]);
  broadcastRuntimeState();
}

function logBootStepTransition(step: IBootStep, outcome: 'ok' | 'failed'): void {
  runtimeState.log(
    outcome === 'ok' ? 'success' : 'error',
    `Boot step: ${step.label} — ${outcome === 'ok' ? 'done' : 'failed'}`,
  );
}

// ---------------------------------------------------------------------------
// Authoritative runtime-state broadcasting (single source of truth)
// ---------------------------------------------------------------------------

function broadcastRuntimeState(): void {
  sendToRenderer(NovaIpcChannel.RUNTIME_STATE_CHANGE, runtimeState.snapshot());
}

runtimeState.on('change', snapshot => {
  try {
    sendToRenderer(NovaIpcChannel.RUNTIME_STATE_CHANGE, snapshot);
  } catch (err) {
    logger.error('[main] runtime-state broadcast failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

runtimeState.on('activity', event => {
  try {
    sendToRenderer(NovaIpcChannel.RUNTIME_ACTIVITY, event);
  } catch (err) {
    logger.error('[main] runtime-activity broadcast failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

function completeBootStep(stepId: string): void {
  const step = bootSteps.find(s => s.stepId === stepId);
  if (!step || step.status === 'completed') return;

  step.status = 'completed';
  step.timestamp = Date.now();

  const next = bootSteps.find(s => s.status === 'pending');
  if (next) {
    next.status = 'active';
    next.timestamp = Date.now();
  }
  // Reflect the real boot progress in the authoritative runtime state.
  switch (stepId) {
    case '1':
      runtimeState.setSubsystem('electron', 'online', '');
      break;
    case '2':
      runtimeState.setSubsystem('microphone', 'online', '');
      break;
    case '3':
      runtimeState.setSubsystem('memory', 'online', '');
      break;
    case '4':
      runtimeState.setSubsystem('gemini', 'online', '');
      runtimeState.setSubsystem('speaker', 'online', '');
      runtimeState.setTask('Ready');
      break;
    default:
      break;
  }
  logBootStepTransition(step, 'ok');
  broadcastBootSteps();
}

function failBootStep(stepId: string): void {
  const step = bootSteps.find(s => s.stepId === stepId);
  if (!step || step.status === 'completed') return;

  step.status = 'failed';
  step.timestamp = Date.now();
  switch (stepId) {
    case '1':
      runtimeState.setSubsystem('electron', 'error', 'database initialization failed');
      break;
    case '2':
      runtimeState.setSubsystem('microphone', 'error', 'voice ingestion failed');
      break;
    case '3':
      runtimeState.setSubsystem('memory', 'error', 'knowledge graph failed');
      break;
    case '4':
      runtimeState.setSubsystem('gemini', 'error', 'Gemini Live connection failed');
      break;
    default:
      break;
  }
  logBootStepTransition(step, 'failed');
  broadcastBootSteps();
}

function sendVoiceState(payload: IVoiceStatePayload): void {
  sendToRenderer(NovaIpcChannel.VOICE_STATE_CHANGE, payload);
}

function buildTelemetryPayload(): ISystemTelemetryPayload {
  const capture = screenCapturer.getTelemetry();
  return {
    captureWidth: capture.width,
    captureHeight: capture.height,
    frameRate: capture.frameRate,
    mutatedBlocks: capture.mutatedBlocks,
    totalBlocks: capture.totalBlocks,
    geminiState: geminiLiveBridge.getConnectionState(),
    streamLatencyMs: geminiLiveBridge.getLatency(),
    timestamp: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// IPC firewall helpers — every handler is validated and sanitized.
// ---------------------------------------------------------------------------

const BINARY_CHANNELS = new Set(['user-audio-chunk', 'camera-frame']);

function guardedOn(channel: string, handler: (...args: any[]) => void): void {
  ipcMain.on(channel, (event, ...args) => {
    if (!ipcFirewall.isAllowed(channel)) {
      logger.audit('ipc.denied', 'denied', { channel });
      return;
    }
    const safeArgs = BINARY_CHANNELS.has(channel) ? args : ipcFirewall.filter(channel, args);
    try {
      handler(event, ...safeArgs);
    } catch (err) {
      logger.error(`[ipc] handler failed for ${channel}`, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });
}

function guardedHandle(channel: string, handler: (...args: any[]) => Promise<any>): void {
  ipcMain.handle(channel, async (_event, ...args) => {
    if (!ipcFirewall.isAllowed(channel)) {
      logger.audit('ipc.denied', 'denied', { channel });
      throw new Error(`IPC channel not permitted: ${channel}`);
    }
    const safeArgs = BINARY_CHANNELS.has(channel) ? args : ipcFirewall.filter(channel, args);
    try {
      return await handler(...safeArgs);
    } catch (err) {
      logger.error(`[ipc] handler failed for ${channel}`, {
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  });
}

// ---------------------------------------------------------------------------
// Window & tray
// ---------------------------------------------------------------------------

function createWindow(): void {
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width, height } = primaryDisplay.workAreaSize;

  const windowIcon = loadAppIcon();
  mainWindow = new BrowserWindow({
    width: Math.min(NovaConfig.windows.windowWidth, width),
    height: Math.min(NovaConfig.windows.windowHeight, height),
    frame: true,
    transparent: false,
    backgroundColor: NovaConfig.windows.backgroundColor,
    hasShadow: true,
    icon: windowIcon ?? undefined,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      // Workspace-first: real web content (YouTube, news sites, PDFs) renders
      // INSIDE NOVA via <webview>. The tag is locked down below with a
      // will-attach-webview sanitizer (no node integration, http(s)/file only)
      // and new-window denial for webview guests, so this is a contained
      // content surface — never a general Node bridge.
      webviewTag: true,
      preload: join(__dirname, 'preload.js'),
    },
  });

  // Vite emits the renderer HTML under dist/renderer (entry src/renderer/
  // preserves the source path). Resolve both candidate layouts so the window
  // always loads the real bundle.
  const RENDERER_HTML = existsSync(join(__dirname, '../renderer/index.html'))
    ? join(__dirname, '../renderer/index.html')
    : join(__dirname, '../renderer/src/renderer/index.html');
  if (!existsSync(RENDERER_HTML)) {
    logger.error('[main] renderer HTML not found', { path: RENDERER_HTML });
  }
  mainWindow.loadFile(RENDERER_HTML);

  mainWindow.webContents.on('did-finish-load', () => {
    bootSteps[0].status = 'active';
    bootSteps[0].timestamp = Date.now();
    broadcastBootSteps();
  });

  // Close hides to tray; real quit happens via tray menu or app.quit().
  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow?.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function createTray(): void {
  try {
    const icon = loadAppIcon() ?? nativeImage.createFromDataURL(
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    );
    tray = new Tray(icon);
    tray.setToolTip('NOVA Genesis — always listening');
    const contextMenu = Menu.buildFromTemplate([
      {
        label: 'Show NOVA HUD',
        click: () => {
          if (mainWindow) {
            mainWindow.show();
            setHudVisible(true);
          }
        },
      },
      { type: 'separator' },
      {
        label: 'Exit',
        click: () => {
          isQuitting = true;
          app.quit();
        },
      },
    ]);
    tray.setContextMenu(contextMenu);
    tray.on('double-click', () => {
      if (mainWindow) {
        mainWindow.show();
        setHudVisible(true);
      }
    });
  } catch (err) {
    logger.error('[main] tray creation failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function setHudVisible(visible: boolean): void {
  if (mainWindow) {
    mainWindow.setIgnoreMouseEvents(!visible, { forward: true });
  }
}

function registerGlobalShortcuts(): void {
  // Global hotkey to summon the HUD from anywhere.
  const ok = windowsIntegration.registerShortcut('CommandOrControl+Shift+H', () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
      setHudVisible(true);
    }
  });
  logger.info('[main] global shortcut registered', { accelerator: 'Ctrl+Shift+H', ok });
}

// ---------------------------------------------------------------------------
// Gemini bridge handlers
// ---------------------------------------------------------------------------

function registerGeminiBridgeHandlers(): void {
  geminiLiveBridge.on('setup-complete', () => {
    completeBootStep('4');
    sendToRenderer(NovaIpcChannel.GEMINI_SETUP_COMPLETE);
    windowsIntegration.notify('NOVA Online', 'Gemini Live session established.');
    logger.info('[main] Gemini Live session established');
  });

  geminiLiveBridge.on('ai-audio-chunk', (chunk: Buffer) => {
    sendToRenderer('ai-audio-chunk', chunk);
    sendVoiceState({
      currentState: 'SPEAKING',
      inputAmplitude: 0,
      streamLatencyMs: geminiLiveBridge.getLatency(),
    });
  });

  geminiLiveBridge.on('ai-amplitude', (amplitude: number) => {
    sendToRenderer('ai-amplitude', amplitude);
  });

  geminiLiveBridge.on('audio-buffer-flush', () => {
    sendToRenderer(NovaIpcChannel.AUDIO_BUFFER_FLUSH);
  });

  geminiLiveBridge.on('tool-call', async (toolCall: unknown) => {
    // Gemini resolved this turn itself by calling a tool — mark it so the
    // voice-request bridge does not re-execute the same action.
    voiceTurnHandledByToolCall = true;
    try {
      const functionResponses = await agentOrchestrator.handleToolCall(toolCall);
      if (functionResponses.length > 0) {
        geminiLiveBridge.sendToolResponse(functionResponses);
      }
    } catch (err) {
      logger.error('[main] tool-call processing failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  geminiLiveBridge.on('user-text-transcribed', (text: string) => {
    // Local Whisper is the canonical command transcript. Gemini still receives
    // microphone audio for its conversational response, but its slower input
    // transcription must not duplicate or delay the local stream.
    if (localWhisperActive) return;
    sendToRenderer(NovaIpcChannel.SPEECH_TEXT_TRANSCRIBED, text);
  });

  geminiLiveBridge.on('connection-state-change', (state: string) => {
    if (state === 'DISCONNECTED' || state === 'ERROR') {
      sendVoiceState({
        currentState: 'IDLE',
        inputAmplitude: 0,
        streamLatencyMs: 0,
      });
      runtimeState.setSubsystem('gemini', 'offline', 'Gemini Live session dropped');
      runtimeState.log('warn', 'Gemini Live disconnected');
    } else if (state === 'CONNECTED') {
      runtimeState.setSubsystem('gemini', 'online', '');
      runtimeState.log('success', 'Gemini Live connected');
    } else if (state === 'CONNECTING') {
      runtimeState.setSubsystem('gemini', 'starting', 'connecting…');
      runtimeState.log('info', 'Gemini Live connecting…');
    }
  });

  geminiLiveBridge.on('error', (err: Error) => {
    logger.error('[main] Gemini Live bridge error', { message: err.message || String(err) });
    runtimeState.setSubsystem('gemini', 'error', err.message || String(err));
    runtimeState.setError(err.message || String(err));
    runtimeState.log('error', 'Gemini Live error: ' + (err.message || String(err)));
  });

  geminiLiveBridge.on(
    'interaction-complete',
    (interaction: {
      transcriptInput: string;
      responseOutput: string;
      latencyMs: number;
      timestamp: number;
    }) => {
      try {
        const uuid = randomUUID();
        interactionLedger.insertInteraction({
          uuid,
          timestamp_epoch: interaction.timestamp,
          interaction_type: 'voice_loop',
          raw_transcript_input: PiiSanitizer.sanitize(interaction.transcriptInput),
          model_response_output: PiiSanitizer.sanitize(interaction.responseOutput),
          context_snapshot_json: JSON.stringify({
            chips: latestChips.chips,
            telemetry: buildTelemetryPayload(),
          }),
          embedding_vector_id: `v_${uuid}`,
          performance_latency_ms: interaction.latencyMs,
        });
        intentForecaster.recordTransition('voice_loop', 'voice_loop');
        void memoryEngine
          .recordInteraction(interaction.transcriptInput, interaction.responseOutput)
          .catch(() => undefined);
      } catch (err) {
        logger.error('[main] failed to record interaction in ledger', {
          error: err instanceof Error ? err.message : String(err),
        });
      }

      // VOICE-FIRST: a spoken request must reach NOVA Core and EXECUTE, not
      // just appear in the transcript. Run the completed user transcription
      // through the same capability bridge as typed text (unless Gemini
      // already resolved the turn by calling a tool itself). The result is
      // broadcast as a NOVA AI transcript entry so the user sees real output.
      const spoken = (interaction.transcriptInput ?? '').trim();
      if (spoken && !localWhisperActive && !voiceTurnHandledByToolCall) {
        void routeVoiceRequest(spoken);
      }
      voiceTurnHandledByToolCall = false;
    },
  );
}

function registerWhisperHandlers(): void {
  whisperLiveBridge.on('partial', (text: string) => {
    sendToRenderer(NovaIpcChannel.SPEECH_TEXT_TRANSCRIBED, { text, partial: true });
  });
  whisperLiveBridge.on('final', (text: string) => {
    sendToRenderer(NovaIpcChannel.SPEECH_TEXT_TRANSCRIBED, { text, partial: false });
    if (text.trim()) void routeVoiceRequest(text.trim());
  });
  whisperLiveBridge.on('error', (err: Error) => {
    localWhisperActive = false;
    logger.warn('[whisper] local transcription unavailable; Gemini fallback active', { error: err.message });
    runtimeState.log('warn', 'Local Whisper unavailable; using Gemini transcription fallback.');
  });
}

async function initializeWhisper(): Promise<void> {
  const result = await pythonRuntime.request('whisper.status', {}, 5000);
  const available = result.ok && Boolean((result.data as { available?: boolean } | null)?.available);
  if (!available) {
    localWhisperActive = false;
    runtimeState.setSubsystem('microphone', 'degraded', 'Local Whisper package unavailable');
    runtimeState.log('warn', 'Local Whisper package unavailable.');
    return;
  }
  // Load the model before accepting microphone audio so the first utterance
  // cannot be mistaken for a worker failure and silently fall back to Gemini.
  const warmup = await pythonRuntime.request('whisper.warmup', {}, 120000);
  localWhisperActive = warmup.ok;
  const reason = warmup.ok ? 'Local Whisper ready' : (warmup.error ?? 'Whisper model failed to load');
  runtimeState.setSubsystem('microphone', warmup.ok ? 'online' : 'degraded', reason);
  runtimeState.log(warmup.ok ? 'success' : 'warn', warmup.ok ? 'Local Whisper streaming transcription ready.' : reason);
}

// ---------------------------------------------------------------------------
// Voice request routing — the P0 "user has to type" fix
// ---------------------------------------------------------------------------

/**
 * Runs a spoken (transcribed) user request through NOVA Core.
 *
 * Voice used to stop at the transcript: `user-text-transcribed` only displayed
 * the text, so the user had to type the same request to get anything executed.
 * Now every completed spoken turn goes through the same intent->capability
 * bridge as typed text. We deliberately do NOT send the text back to Gemini
 * Live (it already heard the audio and is answering) — we only execute real
 * capabilities and surface the outcome.
 */
async function routeVoiceRequest(commandText: string): Promise<void> {
  runtimeState.setTask('Processing voice request');
  runtimeState.log('info', 'Voice request received: ' + commandText.slice(0, 80));
  try {
    // 1) Capability bridge — execute real system actions (screenshot, file
    //    ops, system info, web search, app launch, ...) through the TaskRunner.
    const capabilityMatch = agentOrchestrator.getTaskRunner().matchCapability(commandText);
    if (capabilityMatch) {
      runtimeState.setTask(`Executing: ${capabilityMatch.label}`);
      runtimeState.log('info', `Voice capability match: ${capabilityMatch.id}`);
      const trace = await agentOrchestrator.runTask(commandText);
      if (trace.status === 'completed') {
        runtimeState.setTask('Task complete');
        runtimeState.log('success', `Voice task completed: ${capabilityMatch.label}`);
        // Personality Engine is the final presentation layer for NOVA's own
        // responses — it adds the natural address without altering the facts.
        sendToRenderer('ai-text-token', personalityEngine.transform(`✅ Done — ${trace.summary}`));
      } else {
        runtimeState.setTask('Task failed');
        runtimeState.log('error', trace.summary);
        sendToRenderer('ai-text-token', personalityEngine.transform(`⚠️ ${trace.summary}`));
      }
      return;
    }

    // 2) Reasoning/planning/engineering work is routed to the reasoning
    //    engine (Groq when configured), enriched with memory — mirrors the
    //    typed path so voice gets the same intelligence.
    const route = taskRouter.route(commandText);
    const thinkingWork = ['reasoning', 'engineering', 'planning'].includes(route.kind);
    if (thinkingWork) {
      const thinkingProvider = taskRouter.providerFor(route.kind);
      if (thinkingProvider && thinkingProvider.id === 'groq') {
        runtimeState.setTask('Reasoning with Groq');
        runtimeState.log('info', 'Voice routed to reasoning engine (groq).');
        const memories = await memoryEngine.search(commandText, 4);
        const memoryBlock = memories.map(m => `[${m.kind}] ${m.content}`).join('\n');
        const prompt =
          `You are NOVA's reasoning and engineering engine. Answer the user's request precisely ` +
          `and concisely, using the memory context when it is relevant.\n\n` +
          `Relevant memory:\n${memoryBlock || '(none)'}\n\n` +
          `User request: ${commandText}`;
        const response = await thinkingProvider.generate(prompt, { maxOutputTokens: 1600 });
        logger.audit('ai.reasoning', 'ok', {
          provider: thinkingProvider.id,
          kind: route.kind,
          intent: PiiSanitizer.sanitize(commandText).slice(0, 200),
        });
        void memoryEngine.recordInteraction(commandText, response).catch(() => undefined);
        sendToRenderer('ai-text-token', personalityEngine.transform(response));
        return;
      }
    }

    // 3) No capability matched and it is not thinking work: Gemini Live is
    //    already answering the audio conversationally, so NOVA Core does not
    //    need to do anything more. Log honestly.
    runtimeState.setTask('Ready');
    runtimeState.log('info', 'Voice request: conversational (Gemini Live handles it).');
  } catch (err) {
    runtimeState.setTask('Ready');
    runtimeState.log('error', 'Voice request processing failed: ' + (err instanceof Error ? err.message : String(err)));
    logger.error('[main] routeVoiceRequest failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

// Safety nets for component event emitters
graphEngine.on('ready', () => completeBootStep('3'));
graphEngine.on('error', (err: unknown) => logger.error('[main] graph engine error', { error: String(err) }));
contextEngine.on('error', (err: unknown) => logger.error('[main] context engine error', { error: String(err) }));
voiceProcessor.on('error', (err: unknown) => logger.error('[main] voice processor error', { error: String(err) }));
wakeWordDetector.on('error', (err: unknown) => logger.error('[main] wake word detector error', { error: String(err) }));
dreamMode.on('error', (err: unknown) => logger.error('[main] dream mode error', { error: String(err) }));

// Single-instance guard: a second launch focuses the existing window instead
// of spawning a duplicate process tree.
const singleInstanceLock = app.requestSingleInstanceLock();
if (!singleInstanceLock) {
  app.quit();
}

app.on('second-instance', () => {
  if (mainWindow) {
    mainWindow.show();
    mainWindow.focus();
    setHudVisible(true);
  }
});

app.whenReady().then(async () => {
  if (!singleInstanceLock) {
    app.quit();
    return;
  }
  // Windows app identity: notifications + taskbar grouping.
  try {
    app.setAppUserModelId('com.nova.genesis');
  } catch {
    /* non-Windows */
  }
  bootstrapAudit();
  bootstrapSecrets();

  // Reflect the real configured-provider state (never assumed connected).
  runtimeState.setSubsystem(
    'groq',
    aiProviderRegistry.get('groq')?.isConfigured() ? 'online' : 'unconfigured',
    aiProviderRegistry.get('groq')?.isConfigured() ? '' : 'GROQ_API_KEY not configured',
  );
  if (!aiProviderRegistry.get('groq')?.isConfigured()) {
    runtimeState.log('warn', 'Groq provider is unconfigured — reasoning and tool synthesis are unavailable until GROQ_API_KEY is configured.');
  }

  // Probe the real Python runtime (worker starts lazily on first use).
  void (async () => {
    try {
      const py = await pythonRuntime.status(true);
      runtimeState.setSubsystem(
        'python',
        py.available ? 'online' : 'offline',
        py.available ? '' : (py.lastError ?? 'Python interpreter not found'),
      );
      if (py.available) {
        runtimeState.log('success', `Python runtime connected (${py.version})`);
      } else {
        runtimeState.log('warn', 'Python runtime unavailable: ' + (py.lastError ?? 'not found'));
      }
    } catch (err) {
      runtimeState.setSubsystem('python', 'error', err instanceof Error ? err.message : String(err));
    }
  })();

  // Discover the REAL microphone hardware (via the Python audio service) and
  // reflect its truth in the runtime state. If no capture endpoint exists, the
  // state is UNAVAILABLE — never a fabricated "online".
  void (async () => {
    try {
      await micManager.discover();
      const snap = micManager.snapshot();
      runtimeState.setSubsystem(
        'microphone',
        snap.available ? 'online' : 'offline',
        snap.available ? '' : (snap.lastError ?? 'No microphone input device detected'),
      );
      if (snap.available) {
        runtimeState.log('success', `Microphone ready: ${snap.defaultCapture ?? 'default device'}`);
      } else {
        runtimeState.log('warn', 'Microphone unavailable: ' + (snap.lastError ?? 'no device'));
      }
    } catch (err) {
      runtimeState.setSubsystem('microphone', 'error', err instanceof Error ? err.message : String(err));
    }
  })();

  // Keep the runtime state microphone chip in sync with the real MicManager.
  micManager.on('change', snap => {
    runtimeState.setSubsystem(
      'microphone',
      snap.available ? 'online' : snap.state === 'PERMISSION_REQUIRED' ? 'error' : 'offline',
      snap.available ? '' : (snap.lastError ?? 'No microphone input device detected'),
    );
  });

  // Register the full IPC surface BEFORE the window is created. The renderer
  // can mount and issue its first invoke (the boot-state pull) within
  // milliseconds of loadFile(); handlers registered after createWindow() race
  // that first call and silently reject it, leaving the UI looking like a
  // static mock (tracker stuck on "Awaiting Initializing Signal").
  registerIpcHandlers();
  registerWhisperHandlers();
  void initializeWhisper();

  // Step 1: Database and Graph Engine Initialization
  try {
    graphEngine.init(join(app.getPath('userData'), ''));
    completeBootStep('1');
    if (graphEngine.isReady()) {
      completeBootStep('3');
    }
  } catch (err) {
    logger.error('[main] graph engine initialization failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    failBootStep('1');
    failBootStep('3');
  }

  // Long-term semantic memory (embedding-backed, persisted).
  try {
    memoryEngine.init(app.getPath('userData'));
  } catch (err) {
    logger.error('[main] memory engine initialization failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Personality Engine: canonical final presentation layer. Persisted config
  // (form of address defaults to "Sir") is kept in sync with the identity
  // record so one authoritative address drives memory, voice and responses.
  try {
    personalityEngine.init(app.getPath('userData'));
    const identity = memoryEngine.getIdentity();
    if (identity.preferredAddress !== personalityEngine.address()) {
      memoryEngine.updateIdentity({ preferredAddress: personalityEngine.address() });
    }
    logger.info('[main] personality engine ready', {
      address: personalityEngine.address(),
      voice: personalityEngine.getConfig().formOfAddress,
    });
  } catch (err) {
    logger.error('[main] personality engine initialization failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Tool registry + executor are operational once the orchestrator is up.
  try {
    runtimeState.setSubsystem('toolRegistry', 'online', '');
    runtimeState.setSubsystem('toolExecutor', 'online', '');
  } catch (err) {
    logger.error('[main] tool status update failed', { error: String(err) });
  }

  // Record every tool execution into long-term memory + the live activity feed.
  try {
    agentOrchestrator.getExecutor().on('tool-executed', (evt: { toolId: string; success: boolean }) => {
      const t = agentOrchestrator.getRegistry().get(evt.toolId);
      if (t) {
        void memoryEngine.recordToolExecution(t.name, evt.success).catch(() => undefined);
        runtimeState.log(
          evt.success ? 'success' : 'warn',
          `Tool executed: ${t.name} — ${evt.success ? 'ok' : 'failed'}`,
        );
      }
    });
  } catch (err) {
    logger.error('[main] tool-execution memory hook failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Step 2: Wake Word Detector and Voice Ingestion Setup
  try {
    await wakeWordDetector.initialize();
    voiceProcessor.setWakeWordDetector(wakeWordDetector);
    wakeWordDetector.start();
    wakeWordDetector.on('wake-word-detected', event => {
      try {
        if (geminiLiveBridge.isConnected()) {
          geminiLiveBridge.sendAudioChunk(Buffer.from(event.buffer.buffer));
        }
        sendToRenderer('wake-word-detected', { keyword: event.keyword, timestamp: event.timestamp });
      } catch (err) {
        logger.error('[main] wake-word handler failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });
  } catch (err) {
    logger.error('[main] wake word detector initialization failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    failBootStep('2');
  }

  // Window creation, tray, shortcuts, bridge handlers
  try {
    createWindow();
    createTray();
    registerGlobalShortcuts();
    registerGeminiBridgeHandlers();
  } catch (err) {
    logger.error('[main] window/tray setup failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Wire the NOVA Workspace to the renderer: every surface change pushes the
  // real surface list, and persisted surfaces from a previous session are
  // restored on boot.
  agentOrchestrator.getWorkspace().onUpdate = payload => {
    sendToRenderer(NovaIpcChannel.WORKSPACE_UPDATE, payload);
  };
  const persistedSurfaces = agentOrchestrator.getWorkspace().list();
  if (persistedSurfaces.length > 0) {
    sendToRenderer(NovaIpcChannel.WORKSPACE_UPDATE, { surfaces: persistedSurfaces });
  }

  // Gemini Live Bridge initialization
  try {
    geminiLiveBridge.setToolDeclarations(agentOrchestrator.getToolDeclarations());
    geminiLiveBridge.connectStream();
  } catch (err) {
    logger.error('[main] Gemini Live Bridge connection failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    failBootStep('4');
  }

  // Ingestors and context daemons
  try {
    screenCapturer.startCapture();
    contextEngine.start();
    dreamMode.start();
    dreamMode.on('dream-start', () => {
      sendToRenderer(NovaIpcChannel.DREAM_MODE_START, { status: 'running' });
    });
    dreamMode.on('dream-complete', payload => {
      sendToRenderer(NovaIpcChannel.DREAM_MODE_COMPLETE, payload);
    });
  } catch (err) {
    logger.error('[main] ingestors/daemons start failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Specialized mode detectors
  try {
    meetingMode.detectActiveMeeting().catch(err => logger.error('[main] meetingMode error', { error: String(err) }));
    liveCodingMode.detectActiveEditor().catch(err => logger.error('[main] liveCodingMode error', { error: String(err) }));
    creativeStudio.detectActiveApp().catch(err => logger.error('[main] creativeStudio error', { error: String(err) }));
    void liveCodingMode.startWatching(process.cwd());
  } catch (err) {
    logger.error('[main] specialized modes initialization failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Context Engine foreground window chip updates
  contextEngine.on('context-changed', (chips: IContextChipPayload) => {
    latestChips = chips;
    sendToRenderer(NovaIpcChannel.CONTEXT_CHIP_UPDATE, chips);
  });

  // Telemetry stream at 1Hz (paused while the window is hidden to save CPU).
  telemetryTimer = setInterval(() => {
    try {
      const hidden =
        NovaConfig.telemetry.pauseWhenHidden &&
        (!mainWindow || mainWindow.isDestroyed() || !mainWindow.isVisible() || mainWindow.isMinimized());
      if (hidden) return;
      sendToRenderer(NovaIpcChannel.SYSTEM_TELEMETRY, buildTelemetryPayload());
    } catch (err) {
      logger.error('[main] telemetry broadcast failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }, 1000 / NovaConfig.telemetry.broadcastHz);

  // Barge-in interruption handler
  voiceProcessor.on('speaking-start', () => {
    try {
      geminiLiveBridge.triggerInterruptionCancel();
      sendVoiceState({
        currentState: 'LISTENING',
        inputAmplitude: 0,
        streamLatencyMs: geminiLiveBridge.getLatency(),
      });
    } catch (err) {
      logger.error('[main] interruption cancel failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });
});

// ---------------------------------------------------------------------------
// IPC surface registration (every channel through the firewall)
// ---------------------------------------------------------------------------

function registerIpcHandlers(): void {
  guardedOn('user-audio-chunk', (_event, chunk: Buffer) => {
    if (!voiceIngestionMarked) {
      voiceIngestionMarked = true;
      completeBootStep('2');
    }
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    const pcm = new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 2));
    wakeWordDetector.processAudio(pcm);
    if (localWhisperActive) whisperLiveBridge.pushAudio(buf);
    geminiLiveBridge.sendAudioChunk(buf);
  });

  // VAD speech activity only — drives the voice processor, never the mic
  // state machine. A speech pause (silence) must NOT flip the mic to READY
  // while getUserMedia is still streaming.
  guardedOn('user-speaking-active', (_event, isSpeaking: boolean) => {
    voiceProcessor.reportSpeaking(isSpeaking);
    if (!isSpeaking && localWhisperActive) whisperLiveBridge.endSpeech();
  });

  // Explicit capture-state confirmation from the mic toggle (renderer). Only
  // these events move the mic state machine; they are sent once per actual
  // startRecording/stopRecording so the state always reflects real capture.
  guardedOn(NovaIpcChannel.MIC_CAPTURE_ACTIVE, (_event, active: boolean) => {
    if (active) {
      micManager.reportListening();
    } else {
      micManager.reportStoppedListening();
    }
  });

  guardedOn(NovaIpcChannel.MIC_CAPTURE_ERROR, (_event, message: string) => {
    micManager.reportError(
      typeof message === 'string' && message ? message : 'Microphone capture failed',
    );
  });

  guardedHandle(NovaIpcChannel.MIC_TOGGLE, async () => {
    const snap = micManager.snapshot();
    // In BOTH branches ask the renderer to start/stop the real getUserMedia
    // pipeline; the renderer reports the actual result back via
    // user-speaking-active so the state machine reflects reality (never a
    // claimed state before capture is confirmed).
    sendToRenderer(NovaIpcChannel.MIC_TOGGLE_REQUEST, {});
    return { listening: !snap.listening };
  });

  guardedHandle(NovaIpcChannel.MIC_DIAGNOSTIC, async (_event: unknown, sampleMs?: number) => {
    return micManager.runDiagnostic(typeof sampleMs === 'number' ? sampleMs : 500);
  });

  guardedHandle(NovaIpcChannel.MIC_DISCOVER, async () => {
    await micManager.discover();
    return micManager.snapshot();
  });

  guardedHandle(NovaIpcChannel.MIC_SET_MUTED, async (_event: unknown, muted: boolean) => {
    micManager.setMuted(!!muted);
    return micManager.snapshot();
  });

  guardedHandle(NovaIpcChannel.GET_MIC_STATE, async () => micManager.snapshot());

  // --- NOVA Workspace (internal surfaces) ---
  guardedHandle(NovaIpcChannel.WORKSPACE_LIST, async () => {
    return { surfaces: agentOrchestrator.getWorkspace().list() };
  });

  guardedHandle(NovaIpcChannel.WORKSPACE_CLOSE, async (_event: unknown, id: string) => {
    const closed = agentOrchestrator.getWorkspace().close(String(id ?? ''));
    return { success: closed };
  });

  // Renderer-initiated open (news item clicks, workspace UI links): opens a
  // validated http(s) URL inside the workspace as a web surface — the same
  // workspace-first path the agent uses, never an external browser.
  guardedHandle(NovaIpcChannel.WORKSPACE_OPEN_URL, async (_event: unknown, url: string) => {
    const trimmed = String(url ?? '').trim();
    if (!/^https?:\/\//i.test(trimmed)) {
      return { success: false, error: 'workspace URL must start with http(s)://' };
    }
    const surface = agentOrchestrator.getWorkspace().open({
      type: 'web',
      title: trimmed,
      source: trimmed,
    });
    return { success: true, surfaceId: surface.id };
  });

  guardedOn('window-minimize', () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.minimize();
  });

  guardedOn('window-maximize', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMaximized()) {
        mainWindow.unmaximize();
      } else {
        mainWindow.maximize();
      }
    }
  });

  guardedOn('window-close', () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
  });

  guardedOn(NovaIpcChannel.HUD_VISIBILITY_REQ, (_event, makeVisible: boolean) => {
    setHudVisible(!!makeVisible);
  });

  guardedHandle('capture-desktop-frame', async () => {
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 1280, height: 720 },
    });
    const primary = sources[0];
    if (primary && primary.thumbnail && !primary.thumbnail.isEmpty()) {
      return { data: primary.thumbnail.toDataURL().split(',')[1], mimeType: 'image/jpeg' };
    }
    return null;
  });

  guardedOn('camera-frame', (_event, base64Frame: string) => {
    if (geminiLiveBridge.isConnected() && geminiLiveBridge.getConnectionState() === 'CONNECTED') {
      geminiLiveBridge.sendVisionFrame(base64Frame);
    }
  });

  // Workspace webview lockdown: every <webview> guest is force-reconfigured
  // to a bare content shell — no preload, no node integration, strict context
  // isolation — and may only load http(s) (web/video) or file (local PDFs).
  (app as any).on('will-attach-webview', (event: Event, webPreferences: Record<string, unknown>, params: { src?: string }) => {
    delete webPreferences.preload;
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;
    const src = String(params?.src ?? '');
    if (!/^https?:\/\//i.test(src) && !src.startsWith('file://')) {
      event.preventDefault();
    }
  });

  app.on('web-contents-created', (_event, contents) => {
    // Never let any content (main window or webview guest) spawn popups.
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    // Webview guests may only navigate between http(s)/file targets.
    if (contents.getType() === 'webview') {
      contents.on('will-navigate', (event, url) => {
        if (!/^https?:\/\//i.test(url) && !url.startsWith('file://')) {
          event.preventDefault();
        }
      });
    }
    try {
      contents.session.setPermissionRequestHandler((_wc, permission, callback) => {
        const allowed = ['media', 'audioCapture', 'videoCapture'].includes(permission);
        callback(allowed);
      });
    } catch (err) {
      logger.error('[main] permission handler setup failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  guardedHandle(NovaIpcChannel.TRIGGER_AUTOMATION, async (commandText: string) => {
    runtimeState.setTask('Processing request');
    runtimeState.log('info', 'Request received: ' + commandText.slice(0, 80));
    // 1) Capability bridge: if the request maps to a real built-in capability,
    //    the TaskRunner executes it NOW (plan -> execute -> verify -> recover)
    //    against the real machine, instead of deferring to a conversational
    //    model that may answer with text instead of acting. This is the core
    //    "NOVA Core bridges intent -> action" requirement.
    try {
      const capabilityMatch = agentOrchestrator.getTaskRunner().matchCapability(commandText);
      if (capabilityMatch) {
        runtimeState.setTask(`Executing: ${capabilityMatch.label}`);
        runtimeState.log('info', `Capability match: ${capabilityMatch.id} — executing on the real system.`);
        const trace = await agentOrchestrator.runTask(commandText);
        if (trace.status === 'completed') {
          runtimeState.setTask('Task complete');
          runtimeState.log('success', `Task completed: ${capabilityMatch.label}`);
          // The real result is broadcast through the Personality Engine (the
          // canonical presentation layer) so typed tasks show actual output.
          sendToRenderer('ai-text-token', personalityEngine.transform(`✅ Done — ${trace.summary}`));
        } else {
          runtimeState.setTask('Task failed');
          runtimeState.log('error', trace.summary);
          sendToRenderer('ai-text-token', personalityEngine.transform(`⚠️ ${trace.summary}`));
        }
        return { success: trace.status === 'completed', handled: 'capability', trace };
      }
    } catch (err) {
      logger.warn('[main] capability bridge failed; falling back to provider routing', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    // Reasoning/planning/engineering work is routed to the reasoning engine
    // (Groq when configured), enriched with semantically recalled memory.
    try {
      const route = taskRouter.route(commandText);
      const thinkingWork = ['reasoning', 'engineering', 'planning'].includes(route.kind);
      if (thinkingWork) {
        const thinkingProvider = taskRouter.providerFor(route.kind);
        if (thinkingProvider && thinkingProvider.id === 'groq') {
          runtimeState.setTask('Reasoning with Groq');
          runtimeState.log('info', `Routing to reasoning engine (${thinkingProvider.id}).`);
          const memories = await memoryEngine.search(commandText, 4);
          const memoryBlock = memories.map(m => `[${m.kind}] ${m.content}`).join('\n');
          const prompt =
            `You are NOVA's reasoning and engineering engine. Answer the user's request precisely ` +
            `and concisely, using the memory context when it is relevant.\n\n` +
            `Relevant memory:\n${memoryBlock || '(none)'}\n\n` +
            `User request: ${commandText}`;
          const response = await thinkingProvider.generate(prompt, { maxOutputTokens: 1600 });
          logger.audit('ai.reasoning', 'ok', {
            provider: thinkingProvider.id,
            kind: route.kind,
            intent: PiiSanitizer.sanitize(commandText).slice(0, 200),
          });
          // Persist the reasoning interaction to long-term memory + ledger so
          // it is retrievable later, exactly like voice-loop interactions. The
          // Personality Engine polishes the final presentation (no fact changes).
          void memoryEngine.recordInteraction(commandText, response).catch(() => undefined);
          try {
            const uuid = randomUUID();
            interactionLedger.insertInteraction({
              uuid,
              timestamp_epoch: Date.now(),
              interaction_type: 'reasoning',
              raw_transcript_input: PiiSanitizer.sanitize(commandText),
              model_response_output: PiiSanitizer.sanitize(response),
              context_snapshot_json: JSON.stringify({ provider: thinkingProvider.id, kind: route.kind }),
              embedding_vector_id: `v_${uuid}`,
              performance_latency_ms: 0,
            });
          } catch (err) {
            logger.error('[main] failed to record reasoning interaction', {
              error: err instanceof Error ? err.message : String(err),
            });
          }
          return { success: true, handled: route.kind, provider: thinkingProvider.id, response: personalityEngine.transform(response) };
        }
      }
    } catch (err) {
      logger.warn('[main] reasoning provider failed; falling back to live conversation', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    // Only synthesize a tool when the request maps to a real registered
    // capability or uses automation/media verbs; open-ended conversational
    // requests are handled by the model without polluting the registry.
    const AUTOMATION_HINT =
      /(?:stream|video|news|watch|feed|live|tv|broadcast|tool|automation|create|generate|launch|run|search|analyze|summarize|report|scan|list\s+(?:project|tool)|make|build|write\s+(?:file|project|code)|clipboard|notify|project|ocr|screen|capture|open\s+(?:app|url|file|browser))/i;
    const matchesExisting = agentOrchestrator.getRegistry().findCapability(commandText) !== null;
    if (!matchesExisting && !AUTOMATION_HINT.test(commandText)) {
      // Pure conversational request. If no live session exists and no provider
      // can answer, respond explicitly instead of silently dropping the
      // message — otherwise the UI looks like a mock with an unresponsive
      // backend.
      if (!geminiLiveBridge.isConnected()) {
        const configured = aiProviderRegistry
          .all()
          .filter(p => p.isConfigured())
          .map(p => p.id);
        const hint =
          configured.length === 0
            ? 'No AI provider is configured. Add a GEMINI_API_KEY or GROQ_API_KEY via the NOVA Secrets vault (or environment) to enable responses.'
            : `Provider${configured.length > 1 ? 's' : ''} (${configured.join(', ')}) is configured but the live session is not connected yet; retry in a moment.`;
        return { success: false, handled: 'conversation', error: personalityEngine.transform(hint) };
      }
      geminiLiveBridge.sendTextMessage(commandText);
      return { success: true, handled: 'conversation' };
    }
    // Automation/media intent: prefer the live session when available, then
    // synthesize (or reuse) the tool through the capability pipeline.
    if (geminiLiveBridge.isConnected()) {
      geminiLiveBridge.sendTextMessage(commandText);
    }
    try {
      const { tool, executionOk } = await agentOrchestrator.getBuilder().ensureCapability(commandText);
      return executionOk
        ? {
            success: true,
            tool: { id: tool.id, name: tool.name, status: tool.status },
            executionOk: true,
          }
        : {
            success: false,
            tool: { id: tool.id, name: tool.name, status: tool.status },
            executionOk: false,
            error: 'The tool was registered, but its real production execution failed. Check the tool error details and retry.',
          };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: message };
    }
  });

  guardedHandle(NovaIpcChannel.GET_KNOWLEDGE_NODES, async () => {
    return graphEngine.getNodes();
  });

  guardedHandle(NovaIpcChannel.GET_LEDGER_ENTRIES, async () => {
    return interactionLedger.getInteractions();
  });

  guardedHandle(NovaIpcChannel.VECTOR_SEARCH, async (query: string, k: number = 5) => {
    return graphEngine.searchSimilarNodes(query, k);
  });

  guardedHandle(NovaIpcChannel.LIFE_REPLAY_TIMELINE, async (snapshotJson: string) => {
    const timeline = await lifeReplay.queryAndBuildTimeline(snapshotJson);
    return { timeline };
  });

  guardedHandle(NovaIpcChannel.INTENT_PREDICTION, async (currentType: string) => {
    intentForecaster.recordTransition('IDLE', currentType);
    const predictions = intentForecaster.predictNext(currentType);
    const shouldPreload = intentForecaster.shouldPreload(currentType);
    return { current: currentType, predictions, shouldPreload };
  });

  // --- NOVA Tool Registry + system integration IPC ---
  guardedHandle(NovaIpcChannel.TOOL_REGISTRY_VIEW, async () => {
    return agentOrchestrator.getRegistry().publicView();
  });

  guardedHandle(NovaIpcChannel.TOOL_HEALTH_REPORT, async () => {
    return agentOrchestrator.getRegistry().healthReport();
  });

  guardedHandle(NovaIpcChannel.TOOL_TOGGLE, async (toolId: string, enabled: boolean) => {
    const tool = agentOrchestrator.getRegistry().setEnabled(String(toolId), !!enabled);
    return { ok: !!tool };
  });

  guardedHandle(NovaIpcChannel.RUN_TOOL, async (toolName: string, args: Record<string, unknown>) => {
    const result = await agentOrchestrator.getExecutor().execute(String(toolName), args ?? {});
    return { success: result.success, payload: result.payload, error: result.error };
  });

  // Autonomous computer-task execution: natural language -> plan -> execute
  // -> verify -> recover. Returns a structured trace (never throws for task
  // failures, so the UI always gets a diagnosable result).
  guardedHandle(NovaIpcChannel.RUN_TASK, async (requestText: string) => {
    return agentOrchestrator.runTask(String(requestText ?? ''));
  });

  guardedHandle(NovaIpcChannel.LIST_CAPABILITIES, async () => {
    return agentOrchestrator.listTaskCapabilities();
  });

  guardedHandle(NovaIpcChannel.SYSTEM_INFO_REQUEST, async () => {
    const info = windowsIntegration.getSystemInfo();
    return {
      platform: info.platform,
      arch: info.arch,
      release: info.release,
      hostname: info.hostname,
      cpuModel: info.cpuModel,
      cpuCores: info.cpuCores,
      totalMemoryMb: info.totalMemoryMb,
      freeMemoryMb: info.freeMemoryMb,
      electronVersion: info.electronVersion,
      appVersion: info.appVersion,
    };
  });

  guardedHandle(NovaIpcChannel.CLIPBOARD_READ, async () => {
    return { text: windowsIntegration.readClipboard() };
  });

  guardedHandle(NovaIpcChannel.CLIPBOARD_WRITE, async (text: string) => {
    return { ok: windowsIntegration.writeClipboard(String(text ?? '')) };
  });

  guardedHandle(NovaIpcChannel.AUDIT_RECENT, async (limit: number = 50) => {
    return auditLogger.recent(Math.min(Number(limit) || 50, 500));
  });

  guardedHandle(NovaIpcChannel.NOTIFY, async (title: string, body: string) => {
    return { ok: windowsIntegration.notify(String(title ?? 'NOVA'), String(body ?? '')) };
  });

  guardedHandle(NovaIpcChannel.MEMORY_SEARCH, async (query: string, k: number = 5) => {
    const entries = await memoryEngine.search(
      String(query ?? ''),
      Math.min(Math.max(Number(k) || 5, 1), 20),
    );
    return { entries };
  });

  guardedHandle(NovaIpcChannel.TOOL_APPROVE, async () => {
    const ok = agentOrchestrator.getBuilder().approvePendingTool();
    return { ok };
  });

  guardedHandle(NovaIpcChannel.TOOL_REJECT, async () => {
    const ok = agentOrchestrator.getBuilder().rejectPendingTool();
    return { ok };
  });

  guardedHandle(NovaIpcChannel.TOOL_EXEC_LOG, async (limit: number = 100) => {
    return {
      entries: agentOrchestrator
        .getRegistry()
        .recentExecutions(Math.min(Math.max(Number(limit) || 100, 1), 500)),
    };
  });

  // Pull the authoritative runtime state (mount-time snapshot for late
  // subscribers). The same snapshot is pushed on every change.
  guardedHandle(NovaIpcChannel.GET_RUNTIME_STATE, async () => {
    return {
      state: runtimeState.snapshot(),
      activity: runtimeState.recentActivity(50),
    };
  });

  // State pull: the renderer may mount after the boot lifecycle events were
  // broadcast, so it asks for the current snapshot instead of waiting forever
  // on a one-shot signal that already fired.
  guardedHandle(NovaIpcChannel.GET_BOOT_STATE, async () => {
    return {
      bootSteps: [...bootSteps],
      telemetry: buildTelemetryPayload(),
      voiceState: geminiLiveBridge.getConnectionState(),
      providers: {
        gemini: geminiProvider.isConfigured(),
        groq: aiProviderRegistry.get('groq')?.isConfigured() ?? false,
        liveConnected: geminiLiveBridge.isConnected(),
      },
      timestamp: Date.now(),
    };
  });
}

// ---------------------------------------------------------------------------
// Shutdown
// ---------------------------------------------------------------------------

let servicesShutdown = false;

async function shutdownServices(): Promise<void> {
  if (servicesShutdown) return;
  servicesShutdown = true;
  logger.info('[main] shutting down application services');
  isQuitting = true;
  if (telemetryTimer) {
    clearInterval(telemetryTimer);
    telemetryTimer = null;
  }
  windowsIntegration.unregisterAllShortcuts();
  try { tray?.destroy(); } catch { /* ignore */ }
  try { screenCapturer.stopCapture(); } catch (err) { logger.error('[main] screenCapturer stop error', { error: String(err) }); }
  try { contextEngine.stop(); } catch (err) { logger.error('[main] contextEngine stop error', { error: String(err) }); }
  try { voiceProcessor.stop(); } catch (err) { logger.error('[main] voiceProcessor stop error', { error: String(err) }); }
  try { wakeWordDetector.stop(); void wakeWordDetector.release(); } catch (err) { logger.error('[main] wakeWordDetector stop error', { error: String(err) }); }
  try { dreamMode.stop(); } catch (err) { logger.error('[main] dreamMode stop error', { error: String(err) }); }
  try { await liveCodingMode.stopWatching(); } catch (err) { logger.error('[main] liveCodingMode stop error', { error: String(err) }); }
  try { geminiLiveBridge.disconnectStream(); } catch (err) { logger.error('[main] geminiLiveBridge disconnect error', { error: String(err) }); }
  try { await agentOrchestrator.shutdown(); } catch (err) { logger.error('[main] orchestrator shutdown error', { error: String(err) }); }
  try { await interactionLedger.close(); } catch (err) { logger.error('[main] interactionLedger close error', { error: String(err) }); }
  try { await graphEngine.close(); } catch (err) { logger.error('[main] graphEngine close error', { error: String(err) }); }
  try { auditLogger.close(); } catch (err) { logger.error('[main] auditLogger close error', { error: String(err) }); }
  try { memoryEngine.persist(); } catch (err) { logger.error('[main] memoryEngine persist error', { error: String(err) }); }
  logger.close();
}

let shutdownStarted = false;

app.on('before-quit', () => {
  isQuitting = true;
});

// Genuinely graceful shutdown: prevent the default quit, await the service
// teardown (with a hard cap so a hung service can never trap the app), then
// exit. `app.exit()` skips quit events, so this runs exactly once.
app.on('will-quit', (event) => {
  if (shutdownStarted) return;
  event.preventDefault();
  shutdownStarted = true;
  const teardown = shutdownServices().catch(err =>
    logger.error('[main] shutdown error', { error: err instanceof Error ? err.message : String(err) }),
  );
  void Promise.race([teardown, new Promise(resolve => setTimeout(resolve, 3000))]).finally(() => {
    app.exit(0);
  });
});

process.on('SIGINT', () => {
  void shutdownServices();
  app.quit();
});
process.on('SIGTERM', () => {
  void shutdownServices();
  app.quit();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    // Keep running in the tray; quit only via tray menu or OS shutdown.
    if (isQuitting) {
      app.quit();
    }
  }
});
