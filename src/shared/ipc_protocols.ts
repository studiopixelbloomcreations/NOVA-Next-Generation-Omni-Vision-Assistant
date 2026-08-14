// src/shared/ipc_protocols.ts

export enum AdamIpcChannel {
  VOICE_STATE_CHANGE = 'adam-sys:voice-state-change',
  HUD_VISIBILITY_REQ = 'adam-ui:hud-visibility-req',
  CONTEXT_CHIP_UPDATE = 'adam-ui:context-chip-update',
  TRIGGER_DOCKER_CMD = 'adam-act:trigger-docker-cmd',
  USER_WAVEFORM_INPUT = 'adam-sys:user-waveform-input',
  TRIGGER_AUTOMATION = 'adam-act:trigger-automation',
  GET_KNOWLEDGE_NODES = 'adam-db:get-knowledge-nodes',
  GET_LEDGER_ENTRIES = 'adam-db:get-ledger-entries',
  SPEECH_TEXT_TRANSCRIBED = 'adam-sys:speech-text-transcribed',
  ASK_QUESTION = 'adam-sys:ask-question',
  AUDIO_BUFFER_FLUSH = 'adam-sys:audio-buffer-flush',
  GEMINI_SETUP_COMPLETE = 'adam-sys:gemini-setup-complete',
  MIC_AMPLITUDE_UPDATE = 'adam-sys:mic-amplitude-update',
  SYSTEM_TELEMETRY = 'adam-sys:telemetry-update',
  VECTOR_SEARCH = 'adam-db:vector-search',
  DREAM_MODE_START = 'adam-sys:dream-mode-start',
  DREAM_MODE_COMPLETE = 'adam-sys:dream-mode-complete',
  MODE_CHANGED = 'adam-sys:mode-changed',
  LIFE_REPLAY_TIMELINE = 'adam-labs:life-replay-timeline',
  INTENT_PREDICTION = 'adam-labs:intent-prediction',
  TOOL_REGISTRY_VIEW = 'adam-db:tool-registry-view',
  TOOL_HEALTH_REPORT = 'adam-db:tool-health-report',
  RUN_TOOL = 'adam-act:run-tool',
  RUN_TASK = 'adam-act:run-task',
  LIST_CAPABILITIES = 'adam-db:list-capabilities',
  TOOL_TOGGLE = 'adam-db:tool-toggle',
  SYSTEM_INFO_REQUEST = 'adam-sys:system-info',
  CLIPBOARD_READ = 'adam-sys:clipboard-read',
  CLIPBOARD_WRITE = 'adam-sys:clipboard-write',
  AUDIT_RECENT = 'adam-db:audit-recent',
  NOTIFY = 'adam-sys:notify',
  MEMORY_SEARCH = 'adam-db:memory-search',
  TOOL_APPROVE = 'adam-act:tool-approve',
  TOOL_REJECT = 'adam-act:tool-reject',
  TOOL_EXEC_LOG = 'adam-db:tool-exec-log',
  GET_BOOT_STATE = 'adam-db:get-boot-state',
  RUNTIME_STATE_CHANGE = 'adam-sys:runtime-state-change',
  RUNTIME_ACTIVITY = 'adam-sys:runtime-activity',
  GET_RUNTIME_STATE = 'adam-db:get-runtime-state',
  // Microphone
  MIC_STATE_CHANGE = 'adam-sys:mic-state-change',
  MIC_TOGGLE_REQUEST = 'adam-sys:mic-toggle-request',
  MIC_TOGGLE = 'adam-act:mic-toggle',
  MIC_DIAGNOSTIC = 'adam-db:mic-diagnostic',
  MIC_DISCOVER = 'adam-db:mic-discover',
  MIC_SET_MUTED = 'adam-act:mic-set-muted',
  GET_MIC_STATE = 'adam-db:get-mic-state',
  // Renderer → main: explicit capture-state confirmation from the mic toggle.
  // Deliberately separate from `user-speaking-active` (VAD speech activity) so
  // a speech pause never flips the mic state machine to READY mid-capture.
  MIC_CAPTURE_ACTIVE = 'adam-sys:mic-capture-active',
  MIC_CAPTURE_ERROR = 'adam-sys:mic-capture-error',
  // Workspace (internal A.D.A.M. surfaces)
  WORKSPACE_UPDATE = 'adam-sys:workspace-update',
  WORKSPACE_LIST = 'adam-db:workspace-list',
  WORKSPACE_CLOSE = 'adam-act:workspace-close',
  WORKSPACE_OPEN_URL = 'adam-act:workspace-open-url',
}

/**
 * An internal A.D.A.M. workspace surface. Content stays inside the application
 * unless the user explicitly asks to open something outside A.D.A.M.
 *
 * Conventions per type:
 *  - web | video : `source` is the http(s) URL rendered in a webview.
 *  - image       : `source` is the mime type, `content` is base64 image data.
 *  - news        : `content` is a JSON array of { title, url, source, publishedAt }.
 *  - pdf         : `source` is a local file path rendered in a webview.
 *  - file | note | tool-result | code : `content` is the text.
 */
export type WorkspaceSurfaceType =
  | 'web'
  | 'video'
  | 'image'
  | 'pdf'
  | 'file'
  | 'note'
  | 'news'
  | 'tool-result'
  | 'code';

export interface IWorkspaceSurface {
  id: string;
  type: WorkspaceSurfaceType;
  title: string;
  /** URL (web/video), file path (pdf), or mime type (image). */
  source: string;
  /** Text content, base64 image data, or JSON (news items). */
  content?: string;
  state: 'open' | 'closed';
  /** Task that produced this surface (when applicable). */
  taskId?: string;
  createdAt: number;
  updatedAt: number;
}

export interface IWorkspaceUpdatePayload {
  surfaces: IWorkspaceSurface[];
}

/** Authoritative microphone state (from MicManager). */
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

export interface IAudioDeviceInfo {
  name: string;
  status: string;
  id: string;
  direction: string;
}

export interface IMicStatePayload {
  state: MicState;
  available: boolean;
  listening: boolean;
  muted: boolean;
  devices: IAudioDeviceInfo[];
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

/** Per-subsystem truth from the authoritative RuntimeState hub. */
export type SubsystemStatus =
  | 'starting'
  | 'online'
  | 'degraded'
  | 'offline'
  | 'unconfigured'
  | 'error';

export type OverallStatus = 'BOOTING' | 'ONLINE' | 'DEGRADED' | 'ERROR';

export interface IRuntimeStatePayload {
  bootedAt: number;
  overall: OverallStatus;
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

export interface IActivityEventPayload {
  id: string;
  ts: number;
  level: 'info' | 'success' | 'warn' | 'error';
  message: string;
}

/**
 * Live runtime telemetry emitted by the main process on a ~1Hz cadence.
 * Every field is measured, never fabricated: capture dimensions come from
 * screen.getPrimaryDisplay(), latency from WebSocket ping RTT, block counts
 * from the delta engine's last completed cycle.
 */
export interface ISystemTelemetryPayload {
  captureWidth: number;
  captureHeight: number;
  frameRate: number;
  mutatedBlocks: number;
  totalBlocks: number;
  geminiState: 'DISCONNECTED' | 'CONNECTING' | 'CONNECTED' | 'ERROR';
  streamLatencyMs: number;
  timestamp: number;
}

export interface ILiveStreamPayload {
  success: boolean;
  streamType: 'hls' | 'embed';
  streamUrl: string;
  width?: string;
  height?: string;
}

export type AdamVoiceState = 'IDLE' | 'LISTENING' | 'REASONING' | 'SPEAKING';

export interface IVoiceStatePayload {
  currentState: AdamVoiceState;
  inputAmplitude: number;
  detectedSpeakerId?: string;
  streamLatencyMs: number;
}

export interface IContextChipPayload {
  chips: Array<{
    id: string;
    label: string;
    type: 'application' | 'project' | 'status' | 'alert';
    severity: 'low' | 'medium' | 'critical';
  }>;
}

export interface IInteractionLedgerEntry {
  uuid: string;
  timestamp_epoch: number;
  interaction_type: string;
  raw_transcript_input: string;
  model_response_output: string;
  context_snapshot_json: string;
  embedding_vector_id: string;
  performance_latency_ms: number;
}

export interface IKnowledgeNode {
  node_id: string;
  node_type: string;
  display_name: string;
  metadata_payload: string;
  created_at: number;
  updated_at: number;
}

export interface IKnowledgeEdge {
  edge_id: string;
  source_node_id: string;
  target_node_id: string;
  edge_relationship: string;
  edge_weight: number;
  last_accessed_at: number;
}

export interface IVectorSearchResult {
  node_id: string;
  similarity: number;
  distance: number;
  display_name: string;
}

export interface IModePayload {
  mode: 'IDLE' | 'MEETING' | 'LIVE_CODING' | 'CREATIVE';
  app?: string;
  title?: string;
}

export interface IDreamPayload {
  status: 'running' | 'complete';
  agenda?: string;
}

export interface ILifeReplayTimelinePayload {
  timeline: Array<{ timestamp: number; type: string; input: string; output: string }>;
}

export interface IIntentPredictionPayload {
  current: string;
  predictions: Array<{ type: string; probability: number }>;
  shouldPreload: string | null;
}

export interface IToolRegistryEntry {
  id: string;
  name: string;
  description: string;
  category: string;
  version: string;
  status: string;
  health: string;
  successRate: number;
  executionCount: number;
  enabled: boolean;
}

export interface IToolHealthEntry extends IToolRegistryEntry {
  averageExecutionMs: number;
  lastExecutedAt: number | null;
  lastValidationDate: number | null;
}

export interface ISystemInfoPayload {
  platform: NodeJS.Platform;
  arch: string;
  release: string;
  hostname: string;
  cpuModel: string;
  cpuCores: number;
  totalMemoryMb: number;
  freeMemoryMb: number;
  electronVersion: string;
  appVersion: string;
}

export interface IAuditEventPayload {
  ts: number;
  action: string;
  outcome: 'ok' | 'denied' | 'failed';
  details?: Record<string, unknown>;
}

export interface IMemorySearchPayload {
  entries: Array<{
    id: string;
    kind: string;
    content: string;
    tags: string[];
    score: number;
    timestamp: number;
  }>;
}

export interface IToolApprovalRequestPayload {
  toolId: string | null;
  name: string;
  description: string;
  intent: string;
  requestedAt: number;
}

export interface IToolExecLogEntry {
  toolId: string;
  toolName: string;
  success: boolean;
  durationMs: number;
  timestamp: number;
  error?: string | null;
}
