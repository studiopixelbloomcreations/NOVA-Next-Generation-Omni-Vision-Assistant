// New Backend — contracts/ipc.ts
// The IPC contract the New Backend exposes to the EXISTING Electron renderer.
// These channel names and payload shapes mirror `src/shared/ipc_protocols.ts`
// exactly so the UNCHANGED frontend consumes real backend state. The adapter
// maps these to ipcMain.handle/on.

export const NovaIpcChannel = {
  // --- Existing frontend-facing channels (kept identical) ---
  VOICE_STATE_CHANGE: 'nova-sys:voice-state-change',
  HUD_VISIBILITY_REQ: 'nova-ui:hud-visibility-req',
  CONTEXT_CHIP_UPDATE: 'nova-ui:context-chip-update',
  USER_WAVEFORM_INPUT: 'nova-sys:user-waveform-input',
  TRIGGER_AUTOMATION: 'nova-act:trigger-automation',
  GET_KNOWLEDGE_NODES: 'nova-db:get-knowledge-nodes',
  GET_LEDGER_ENTRIES: 'nova-db:get-ledger-entries',
  SPEECH_TEXT_TRANSCRIBED: 'nova-sys:speech-text-transcribed',
  AUDIO_BUFFER_FLUSH: 'nova-sys:audio-buffer-flush',
  GEMINI_SETUP_COMPLETE: 'nova-sys:gemini-setup-complete',
  MIC_AMPLITUDE_UPDATE: 'nova-sys:mic-amplitude-update',
  SYSTEM_TELEMETRY: 'nova-sys:telemetry-update',
  VECTOR_SEARCH: 'nova-db:vector-search',
  DREAM_MODE_START: 'nova-sys:dream-mode-start',
  DREAM_MODE_COMPLETE: 'nova-sys:dream-mode-complete',
  MODE_CHANGED: 'nova-sys:mode-changed',
  LIFE_REPLAY_TIMELINE: 'nova-labs:life-replay-timeline',
  INTENT_PREDICTION: 'nova-labs:intent-prediction',
  TOOL_REGISTRY_VIEW: 'nova-db:tool-registry-view',
  TOOL_HEALTH_REPORT: 'nova-db:tool-health-report',
  RUN_TOOL: 'nova-act:run-tool',
  RUN_TASK: 'nova-act:run-task',
  LIST_CAPABILITIES: 'nova-db:list-capabilities',
  TOOL_TOGGLE: 'nova-db:tool-toggle',
  SYSTEM_INFO_REQUEST: 'nova-sys:system-info',
  CLIPBOARD_READ: 'nova-sys:clipboard-read',
  CLIPBOARD_WRITE: 'nova-sys:clipboard-write',
  AUDIT_RECENT: 'nova-db:audit-recent',
  NOTIFY: 'nova-sys:notify',
  MEMORY_SEARCH: 'nova-db:memory-search',
  TOOL_APPROVE: 'nova-act:tool-approve',
  TOOL_REJECT: 'nova-act:tool-reject',
  TOOL_EXEC_LOG: 'nova-db:tool-exec-log',
  GET_BOOT_STATE: 'nova-db:get-boot-state',
  RUNTIME_STATE_CHANGE: 'nova-sys:runtime-state-change',
  RUNTIME_ACTIVITY: 'nova-sys:runtime-activity',
  GET_RUNTIME_STATE: 'nova-db:get-runtime-state',
  MIC_STATE_CHANGE: 'nova-sys:mic-state-change',
  MIC_TOGGLE_REQUEST: 'nova-sys:mic-toggle-request',
  MIC_TOGGLE: 'nova-act:mic-toggle',
  MIC_DIAGNOSTIC: 'nova-db:mic-diagnostic',
  MIC_DISCOVER: 'nova-db:mic-discover',
  MIC_SET_MUTED: 'nova-act:mic-set-muted',
  GET_MIC_STATE: 'nova-db:get-mic-state',
  MIC_CAPTURE_ACTIVE: 'nova-sys:mic-capture-active',
  MIC_CAPTURE_ERROR: 'nova-sys:mic-capture-error',
  WORKSPACE_UPDATE: 'nova-sys:workspace-update',
  WORKSPACE_LIST: 'nova-db:workspace-list',
  WORKSPACE_CLOSE: 'nova-act:workspace-close',
  WORKSPACE_OPEN_URL: 'nova-act:workspace-open-url',
  // Events pushed to the renderer (mirror existing).
  AI_TEXT_TOKEN: 'ai-text-token',
  AI_AMPLITUDE: 'ai-amplitude',
  AI_AUDIO_CHUNK: 'ai-audio-chunk',
  AGENT_PROGRESS: 'agent-progress-update',
  AGENT_TOOL_CREATED: 'agent-tool-created',
  AGENT_SYNTHESIS_PHASE: 'agent-tool-synthesis-phase',
  AGENT_SYNTHESIS_STEPS: 'agent-tool-synthesis-steps',
  AGENT_APPROVAL_REQUEST: 'agent-tool-approval-request',
  WAKE_WORD_DETECTED: 'wake-word-detected',
  BOOT_LIFECYCLE: 'nova-ipc:boot-lifecycle',
  // Renderer→main audio/video + input sends.
  USER_AUDIO_CHUNK: 'user-audio-chunk',
  USER_SPEAKING_ACTIVE: 'user-speaking-active',
  CAMERA_FRAME: 'camera-frame',
  // Backward-compatible A.D.A.M. additions.
  NB_PING: 'nova2:ping',
  NB_INTENT: 'nova2:intent',
  NB_PLAN: 'nova2:plan',
  NB_CAPABILITIES: 'nova2:capabilities',
  NB_TELEMETRY: 'nova2:telemetry',
  NB_MEMORY: 'nova2:memory',
  NB_ACTIVITY_STREAM: 'nova2:activity',
} as const;

export type NovaIpcChannel = (typeof NovaIpcChannel)[keyof typeof NovaIpcChannel];

/** Mirror of src/shared/ipc_protocols.ts IRuntimeStatePayload. */
export interface RuntimeStatePayload {
  bootedAt: number;
  overall: 'BOOTING' | 'ONLINE' | 'DEGRADED' | 'ERROR';
  electron: SubsystemStatus;
  python: SubsystemStatus;
  gemini: SubsystemStatus;
  groq: SubsystemStatus;
  memory: SubsystemStatus;
  toolRegistry: SubsystemStatus;
  toolExecutor: SubsystemStatus;
  microphone: SubsystemStatus;
  speaker: SubsystemStatus;
  details: Record<string, string>;
  currentTask: string;
  lastError: string | null;
  uptimeMs: number;
  timestamp: number;
}

export type SubsystemStatus = 'starting' | 'online' | 'degraded' | 'offline' | 'unconfigured' | 'error';

export interface ActivityEvent {
  id: string;
  ts: number;
  level: 'info' | 'success' | 'warn' | 'error';
  message: string;
}

export interface BootStep {
  stepId: string;
  label: string;
  status: 'pending' | 'active' | 'completed' | 'failed';
  timestamp: number;
}

export interface BootStatePayload {
  bootSteps: BootStep[];
  telemetry: SystemTelemetryPayload | null;
  voiceState: 'DISCONNECTED' | 'CONNECTING' | 'CONNECTED' | 'ERROR';
  providers: { gemini: boolean; groq: boolean; liveConnected: boolean };
  timestamp: number;
}

/** Mirror of ISystemTelemetryPayload. */
export interface SystemTelemetryPayload {
  captureWidth: number;
  captureHeight: number;
  frameRate: number;
  mutatedBlocks: number;
  totalBlocks: number;
  geminiState: 'DISCONNECTED' | 'CONNECTING' | 'CONNECTED' | 'ERROR';
  streamLatencyMs: number;
  timestamp: number;
}

/** Mirror of IMicStatePayload. */
export interface MicStatePayload {
  state: MicState;
  available: boolean;
  listening: boolean;
  muted: boolean;
  devices: AudioDeviceInfo[];
  defaultCapture: string | null;
  lastError: string | null;
  lastDiagnostic: {
    ok: boolean;
    sampleRate?: number;
    frames?: number;
    rms?: number;
    peak?: number;
    hasSignal?: boolean;
    error?: string;
  } | null;
  timestamp: number;
}

export type MicState =
  | 'DISCONNECTED'
  | 'UNAVAILABLE'
  | 'PERMISSION_REQUIRED'
  | 'INITIALIZING'
  | 'READY'
  | 'LISTENING'
  | 'PAUSED'
  | 'ERROR'
  | 'STOPPING';

export interface AudioDeviceInfo {
  name: string;
  status: string;
  id: string;
  direction: string;
}

/** Mirror of IVoiceStatePayload. */
export interface VoiceStatePayload {
  currentState: 'IDLE' | 'LISTENING' | 'REASONING' | 'SPEAKING';
  inputAmplitude: number;
  detectedSpeakerId?: string;
  streamLatencyMs: number;
}

/** Mirror of IContextChipPayload. */
export interface ContextChipPayload {
  chips: Array<{
    id: string;
    label: string;
    type: 'application' | 'project' | 'status' | 'alert';
    severity: 'low' | 'medium' | 'critical';
  }>;
}

export interface WorkspaceSurface {
  id: string;
  type: 'web' | 'video' | 'image' | 'pdf' | 'file' | 'note' | 'news' | 'tool-result' | 'code';
  title: string;
  source: string;
  content?: string;
  state: 'open' | 'closed';
  taskId?: string;
  createdAt: number;
  updatedAt: number;
}
