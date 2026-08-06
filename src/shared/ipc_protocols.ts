// src/shared/ipc_protocols.ts

export enum NovaIpcChannel {
  VOICE_STATE_CHANGE = 'nova-sys:voice-state-change',
  HUD_VISIBILITY_REQ = 'nova-ui:hud-visibility-req',
  CONTEXT_CHIP_UPDATE = 'nova-ui:context-chip-update',
  TRIGGER_DOCKER_CMD = 'nova-act:trigger-docker-cmd',
  USER_WAVEFORM_INPUT = 'nova-sys:user-waveform-input',
  TRIGGER_AUTOMATION = 'nova-act:trigger-automation',
  GET_KNOWLEDGE_NODES = 'nova-db:get-knowledge-nodes',
  GET_LEDGER_ENTRIES = 'nova-db:get-ledger-entries',
  SPEECH_TEXT_TRANSCRIBED = 'nova-sys:speech-text-transcribed',
  ASK_QUESTION = 'nova-sys:ask-question',
  AUDIO_BUFFER_FLUSH = 'nova-sys:audio-buffer-flush',
  GEMINI_SETUP_COMPLETE = 'nova-sys:gemini-setup-complete',
  MIC_AMPLITUDE_UPDATE = 'nova-sys:mic-amplitude-update',
  SYSTEM_TELEMETRY = 'nova-sys:telemetry-update',
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

export type NovaVoiceState = 'IDLE' | 'LISTENING' | 'REASONING' | 'SPEAKING';

export interface IVoiceStatePayload {
  currentState: NovaVoiceState;
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
