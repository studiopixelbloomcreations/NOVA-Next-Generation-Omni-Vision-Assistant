import './env';
import { app, BrowserWindow, ipcMain, screen } from 'electron';
import { join } from 'path';
import { randomUUID } from 'crypto';
import {
  NovaIpcChannel,
  IVoiceStatePayload,
  IContextChipPayload,
  ISystemTelemetryPayload,
} from '../shared/ipc_protocols';
import { screenCapturer } from './ingestors/screen_capturer';
import { voiceProcessor } from './ingestors/voice_processor';
import { contextEngine } from './services/context_engine';
import { geminiLiveBridge } from './services/gemini_live_bridge';
import { agentOrchestrator } from './services/agent_orchestrator';
import { interactionLedger } from './db/sqlite_adapter';
import { graphEngine } from './db/graph_engine';

let mainWindow: BrowserWindow | null = null;
let voiceIngestionMarked = false;
let telemetryTimer: NodeJS.Timeout | null = null;
let latestChips: IContextChipPayload = { chips: [] };

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

// Global safety nets: a rejected background promise (DB write, capture cycle)
// must never take the whole desktop process down silently.
process.on('unhandledRejection', (reason) => {
  console.error('[main] unhandled promise rejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[main] uncaught exception:', err);
});

function sendToRenderer(channel: string, ...args: unknown[]): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, ...args);
  }
}

function broadcastBootSteps(): void {
  sendToRenderer('nova-ipc:boot-lifecycle', [...bootSteps]);
}

function completeBootStep(stepId: string): void {
  const step = bootSteps.find((s) => s.stepId === stepId);
  if (!step || step.status === 'completed') return;

  step.status = 'completed';
  step.timestamp = Date.now();

  const next = bootSteps.find((s) => s.status === 'pending');
  if (next) {
    next.status = 'active';
    next.timestamp = Date.now();
  }

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

function createWindow() {
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width, height } = primaryDisplay.workAreaSize;

  mainWindow = new BrowserWindow({
    width: Math.min(1280, width),
    height: Math.min(800, height),
    frame: true,
    transparent: false,
    backgroundColor: '#020205',
    hasShadow: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      webviewTag: true,
    },
  });

  if (process.env.NODE_ENV === 'development') {
    mainWindow.loadURL('http://localhost:8080');
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  }

  mainWindow.webContents.on('did-finish-load', () => {
    bootSteps[0].status = 'active';
    bootSteps[0].timestamp = Date.now();
    broadcastBootSteps();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function registerGeminiBridgeHandlers(): void {
  geminiLiveBridge.on('setup-complete', () => {
    completeBootStep('4');
    sendToRenderer(NovaIpcChannel.GEMINI_SETUP_COMPLETE);
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
    try {
      const functionResponses = await agentOrchestrator.handleToolCall(toolCall);
      if (functionResponses.length > 0) {
        geminiLiveBridge.sendToolResponse(functionResponses);
      }
    } catch (err) {
      console.error('[main] tool-call processing failed:', err);
    }
  });

  geminiLiveBridge.on('user-text-transcribed', (text: string) => {
    sendToRenderer(NovaIpcChannel.SPEECH_TEXT_TRANSCRIBED, text);
  });

  geminiLiveBridge.on('connection-state-change', (state: string) => {
    if (state === 'DISCONNECTED' || state === 'ERROR') {
      sendVoiceState({
        currentState: 'IDLE',
        inputAmplitude: 0,
        streamLatencyMs: 0,
      });
    }
  });

  // The bridge emits 'error' as an EventEmitter event; without a listener,
  // Node converts it into an uncaught exception that kills the main process.
  geminiLiveBridge.on('error', (err: Error) => {
    console.error('[main] Gemini Live bridge error:', err.message);
  });

  // Persist every completed conversational turn into the interaction ledger.
  geminiLiveBridge.on(
    'interaction-complete',
    (interaction: { transcriptInput: string; responseOutput: string; latencyMs: number; timestamp: number }) => {
      const uuid = randomUUID();
      interactionLedger
        .insertInteraction({
          uuid,
          timestamp_epoch: interaction.timestamp,
          interaction_type: 'voice_loop',
          raw_transcript_input: interaction.transcriptInput,
          model_response_output: interaction.responseOutput,
          context_snapshot_json: JSON.stringify({
            chips: latestChips.chips,
            telemetry: buildTelemetryPayload(),
          }),
          embedding_vector_id: `v_${uuid}`,
          performance_latency_ms: interaction.latencyMs,
        })
        .catch((err) => {
          console.error('[main] failed to persist interaction to ledger:', err);
        });
    }
  );
}

graphEngine.on('ready', () => {
  completeBootStep('3');
});

app.whenReady().then(() => {
  createWindow();
  registerGeminiBridgeHandlers();

  completeBootStep('1');

  if (graphEngine.isReady()) {
    completeBootStep('3');
  }

  geminiLiveBridge.setToolDeclarations(agentOrchestrator.getToolDeclarations());
  geminiLiveBridge.connectStream();

  screenCapturer.startCapture();
  contextEngine.start();

  // Foreground-window context: forward real chips whenever the tracker
  // observes a change (replaces the previous hardcoded VS Code stub).
  contextEngine.on('context-changed', (chips: IContextChipPayload) => {
    latestChips = chips;
    sendToRenderer(NovaIpcChannel.CONTEXT_CHIP_UPDATE, chips);
  });

  // Live system telemetry at 1Hz — every field measured, none fabricated.
  telemetryTimer = setInterval(() => {
    sendToRenderer(NovaIpcChannel.SYSTEM_TELEMETRY, buildTelemetryPayload());
  }, 1000);

  // Edge-triggered interruption: voiceProcessor collapses per-buffer speaking
  // reports into start/end transitions so barge-in cancel fires exactly once.
  voiceProcessor.on('speaking-start', () => {
    geminiLiveBridge.triggerInterruptionCancel();
    sendVoiceState({
      currentState: 'LISTENING',
      inputAmplitude: 0,
      streamLatencyMs: geminiLiveBridge.getLatency(),
    });
  });

  ipcMain.on('user-audio-chunk', (_event, chunk: Buffer) => {
    if (!voiceIngestionMarked) {
      voiceIngestionMarked = true;
      completeBootStep('2');
    }
    try {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      geminiLiveBridge.sendAudioChunk(buf);
    } catch (e) {
      console.error('[main] failed to process user-audio-chunk:', e);
    }
  });

  ipcMain.on('user-speaking-active', (_event, isSpeaking: boolean) => {
    voiceProcessor.reportSpeaking(isSpeaking);
  });

  ipcMain.on('window-minimize', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.minimize();
    }
  });

  ipcMain.on('window-maximize', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMaximized()) {
        mainWindow.unmaximize();
      } else {
        mainWindow.maximize();
      }
    }
  });

  ipcMain.on('window-close', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.close();
    }
  });

  ipcMain.on(NovaIpcChannel.HUD_VISIBILITY_REQ, (_event, makeVisible: boolean) => {
    if (mainWindow) {
      mainWindow.setIgnoreMouseEvents(!makeVisible, { forward: true });
    }
  });

  ipcMain.handle(NovaIpcChannel.TRIGGER_AUTOMATION, async (_event, commandText: string) => {
    try {
      // Route the raw command into the live conversational session; the model
      // replies over the existing audio/text stream.
      geminiLiveBridge.sendTextMessage(commandText);

      // Dynamic tool synthesis is currently a live-stream widget compiler;
      // only engage it when the intent actually asks for one.
      if (/\b(stream|video|news|watch|feed|live|tv|broadcast)\b/i.test(commandText)) {
        const toolDef = await agentOrchestrator.generateToolFromIntent(commandText);
        return { success: true, tool: { id: toolDef.id, name: toolDef.name, status: toolDef.status } };
      }
      return { success: true };
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      console.error('[main] automation trigger failed:', message);
      return { success: false, error: message };
    }
  });

  ipcMain.handle(NovaIpcChannel.GET_KNOWLEDGE_NODES, async () => {
    return await graphEngine.getNodes();
  });

  ipcMain.handle(NovaIpcChannel.GET_LEDGER_ENTRIES, async () => {
    return await interactionLedger.getInteractions();
  });
});

app.on('before-quit', () => {
  if (telemetryTimer) {
    clearInterval(telemetryTimer);
    telemetryTimer = null;
  }
  screenCapturer.stopCapture();
  contextEngine.stop();
  voiceProcessor.stop();
  geminiLiveBridge.disconnectStream();
  void interactionLedger.close();
  void graphEngine.close();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
