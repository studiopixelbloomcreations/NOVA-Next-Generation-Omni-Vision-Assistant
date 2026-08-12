// New Backend — contracts/ipc.ts
// The IPC contract the New Backend exposes to the existing Electron renderer.
//
// These channel names mirror the frontend's existing expectations in
// `src/shared/ipc_protocols.ts` so the New Backend can be wired to the
// UNCHANGED UI with zero visual changes. The Electron adapter maps these to
// ipcMain.handle/on. Additions are confined to the trailing `nova2-*` block and
// are strictly backward-compatible (the frontend simply never calls them).

export const NovaIpcChannel = {
  // --- Existing frontend-facing channels (kept identical) ---
  TRIGGER_AUTOMATION: 'nova-act:trigger-automation',
  RUN_TOOL: 'nova-act:run-tool',
  RUN_TASK: 'nova-act:run-task',
  LIST_CAPABILITIES: 'nova-db:list-capabilities',
  TOOL_REGISTRY_VIEW: 'nova-db:tool-registry-view',
  TOOL_HEALTH_REPORT: 'nova-db:tool-health-report',
  TOOL_EXEC_LOG: 'nova-db:tool-exec-log',
  TOOL_TOGGLE: 'nova-db:tool-toggle',
  MEMORY_SEARCH: 'nova-db:memory-search',
  SYSTEM_INFO_REQUEST: 'nova-sys:system-info',
  GET_RUNTIME_STATE: 'nova-db:get-runtime-state',
  GET_BOOT_STATE: 'nova-db:get-boot-state',
  WORKSPACE_LIST: 'nova-db:workspace-list',
  WORKSPACE_CLOSE: 'nova-act:workspace-close',
  WORKSPACE_OPEN_URL: 'nova-act:workspace-open-url',
  // --- Events pushed to the renderer ---
  RUNTIME_STATE_CHANGE: 'nova-sys:runtime-state-change',
  RUNTIME_ACTIVITY: 'nova-sys:runtime-activity',
  WORKSPACE_UPDATE: 'nova-sys:workspace-update',
  SPEECH_TEXT_TRANSCRIBED: 'nova-sys:speech-text-transcribed',
  VOICE_STATE_CHANGE: 'nova-sys:voice-state-change',
  // AI text presentation through the existing token channel.
  AI_TEXT_TOKEN: 'ai-text-token',
  AI_AMPLITUDE: 'ai-amplitude',
  AI_AUDIO_CHUNK: 'ai-audio-chunk',
  AGENT_PROGRESS: 'agent-progress-update',
  AGENT_TOOL_CREATED: 'agent-tool-created',
  AGENT_SYNTHESIS_PHASE: 'agent-tool-synthesis-phase',
  AGENT_SYNTHESIS_STEPS: 'agent-tool-synthesis-steps',

  // --- Minimal backward-compatible additions (never required by the UI) ---
  NB_PING: 'nova2:ping',
  NB_INTENT: 'nova2:intent',
  NB_PLAN: 'nova2:plan',
  NB_CAPABILITIES: 'nova2:capabilities',
  NB_TELEMETRY: 'nova2:telemetry',
  NB_MEMORY: 'nova2:memory',
  NB_ACTIVITY_STREAM: 'nova2:activity',
} as const;

export type NovaIpcChannel = (typeof NovaIpcChannel)[keyof typeof NovaIpcChannel];

export interface RuntimeStatePayload {
  bootedAt: number;
  overall: 'BOOTING' | 'ONLINE' | 'DEGRADED' | 'ERROR';
  python: 'starting' | 'online' | 'degraded' | 'offline' | 'error' | 'unconfigured';
  providers: Record<string, string>;
  capabilityIndex: 'starting' | 'online' | 'degraded' | 'error';
  orchestrator: 'starting' | 'online' | 'error';
  currentTask: string;
  lastError: string | null;
  uptimeMs: number;
  timestamp: number;
  backend: 'NEW_BACKEND_v2';
}

export interface ActivityEvent {
  id: string;
  ts: number;
  level: 'info' | 'success' | 'warn' | 'error';
  message: string;
}

export interface BootStatePayload {
  bootSteps: Array<{ stepId: string; label: string; status: 'pending' | 'active' | 'completed' | 'failed'; timestamp: number }>;
  timestamp: number;
  backend: 'NEW_BACKEND_v2';
}
