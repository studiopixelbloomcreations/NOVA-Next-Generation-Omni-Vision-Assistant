// New Backend — contracts/domain.ts
// Canonical typed domain models for the entire backend. Every engine consumes
// these contracts so no module reaches into another's internals and no raw
// shapes leak across service boundaries.

// ---------------------------------------------------------------------------
// Input / Request
// ---------------------------------------------------------------------------

export type RequestSource = 'whisper' | 'typed' | 'multimodal' | 'system' | 'task';

/** Every user-originated turn is normalized into a RequestEnvelope. */
export interface RequestEnvelope {
  requestId: string;
  timestamp: number;
  source: RequestSource;
  /** Raw user text (transcript or typed). */
  transcript: string;
  language: string;
  wakeWordDetected: boolean;
  /** Deps injected by the Input Engine, mirroring the current NOVA context. */
  currentWorkspace?: string;
  currentTask?: string;
  memoryContext?: string[];
  environmentSnapshot?: EnvironmentSnapshot;
}

// ---------------------------------------------------------------------------
// Intent
// ---------------------------------------------------------------------------

export type IntentKind =
  | 'conversational'
  | 'informational'
  | 'workspace'
  | 'computer_task'
  | 'multi_step_task'
  | 'engineering_task'
  | 'tool_creation'
  | 'system_task'
  | 'background_task';

export interface StructuredIntent {
  kind: IntentKind;
  /** Short label, e.g. "analyze_directory". */
  label: string;
  /** Key noun phrases / entities relevant to the task. */
  entities: string[];
  /** Confidence 0..1 from AI-assisted classification. */
  confidence: number;
  /** The raw normalized request. */
  raw: string;
  /** Rough action verb, e.g. "analyze", "open", "create". */
  action: string;
  /** Suggested flags (used by the planner). */
  needsResearch: boolean;
  needsToolCreation: boolean;
}

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

export interface EnvironmentSnapshot {
  platform: NodeJS.Platform;
  arch: string;
  osRelease: string;
  hostname: string;
  cpuModel: string;
  cpuCores: number;
  totalMemoryMb: number;
  freeMemoryMb: number;
  activeWindow?: string | null;
  runningApps: string[];
  processes: Array<{ pid: number; name: string; cpu?: number; memMb?: number }>;
  clipboard?: string | null;
  cwd: string;
  homeDir: string;
  workspaceDir: string;
  toolsDir: string;
  pythonAvailable: boolean;
  pythonVersion?: string;
  networkUp: boolean;
  capturedAt: number;
}

// ---------------------------------------------------------------------------
// Capability / Tools
// ---------------------------------------------------------------------------

export type ToolPermissionType =
  | 'fs-read'
  | 'fs-write'
  | 'net-http'
  | 'net-https'
  | 'child-process'
  | 'native-module'
  | 'clipboard'
  | 'notification';

export interface ToolPermission {
  type: ToolPermissionType;
  /** Paths (fs), URL hosts (net), or '*' for broad access. */
  scope: string[];
}

export type ToolRuntime = 'builtin' | 'python' | 'generated';
export type ToolStatus = 'pending' | 'active' | 'disabled' | 'failed';
export type ToolHealth = 'healthy' | 'degraded' | 'unhealthy' | 'unknown';

export interface ToolVersion {
  version: string;
  sourceHash: string;
  sourceCode: string;
  createdAt: number;
  validation: ValidationReport;
}

/** The single canonical description of a capability NOVA can invoke. */
export interface ToolDefinition {
  id: string;
  /** Stable machine id, e.g. `largest_files`. */
  technicalId: string;
  /** Human display name, e.g. "File Scout". */
  displayName: string;
  description: string;
  category: string;
  author: 'system' | 'user' | 'ai';
  version: string;
  runtime: ToolRuntime;
  /** Absolute path to .py source for runtime === 'python' | 'generated'. */
  sourcePath?: string;
  capabilities: string[];
  permissions: ToolPermission[];
  dependencies: string[];
  /** The run(params) Python source (for generated/python tools). */
  sourceCode?: string;
  sourceHash: string;
  enabled: boolean;
  status: ToolStatus;
  health: ToolHealth;
  createdAt: number;
  updatedAt: number;
  lastExecutedAt: number | null;
  lastValidationDate: number | null;
  executionCount: number;
  successCount: number;
  totalExecutionTimeMs: number;
  versions: ToolVersion[];
}

/** Result of a semantic capability search. */
export interface CapabilityMatch {
  toolId: string;
  toolName: string;
  description: string;
  confidence: number;
  permissions: ToolPermission[];
  health: ToolHealth;
  latency: number;
  successRate: number;
  version: string;
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

export interface PlanStep {
  id: string;
  goal: string;
  capability: string;
  tool: string | null;
  args: Record<string, unknown>;
  verification: string;
  fallbackStrategies: string[];
  timeoutMs: number;
}

export interface ExecutionPlan {
  goal: string;
  steps: PlanStep[];
  dependencies: string[];
  requiredCapabilities: string[];
  expectedResults: string[];
  verificationStrategy: string;
  fallbackStrategies: string[];
  timeoutMs: number;
  riskLevel: 'low' | 'medium' | 'high';
}

// ---------------------------------------------------------------------------
// Validation / Testing
// ---------------------------------------------------------------------------

export type ValidationSeverity = 'error' | 'warning';

export interface ValidationViolation {
  code: string;
  severity: ValidationSeverity;
  message: string;
}

export interface ValidationReport {
  passed: boolean;
  violations: ValidationViolation[];
  testedAt: number;
  inferredPermissions: ToolPermission[];
  checksum: string;
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

export interface ToolExecutionResult {
  toolId: string;
  toolName: string;
  success: boolean;
  payload: unknown;
  error: string | null;
  durationMs: number;
  timestamp: number;
  attempts: number;
}

export interface StepResult {
  step: PlanStep;
  tool: ToolDefinition | null;
  success: boolean;
  payload: unknown;
  error: string | null;
  attempts: number;
  verification: { passed: boolean; detail: string };
}

// ---------------------------------------------------------------------------
// Failure / Recovery
// ---------------------------------------------------------------------------

export type FailureClass =
  | 'tool_error'
  | 'dependency_error'
  | 'timeout'
  | 'permission'
  | 'environment_mismatch'
  | 'network_failure'
  | 'application_failure'
  | 'verification_failure'
  | 'malformed_output'
  | 'provider_unavailable';

export interface FailureReport {
  class: FailureClass;
  message: string;
  attempts: number;
  detail?: Record<string, unknown>;
}

export type RecoveryAction =
  | 'retry'
  | 'alternative_strategy'
  | 'alternative_tool'
  | 'repair_tool'
  | 'create_tool'
  | 'restart_worker'
  | 'replan';

export interface RecoveryDecision {
  action: RecoveryAction;
  rationale: string;
}

// ---------------------------------------------------------------------------
// Ledger / Trace
// ---------------------------------------------------------------------------

export type TaskStatus = 'completed' | 'partial' | 'failed' | 'cancelled';

export interface ExecutionLedgerEntry {
  /** Unique record id (== executionId). Used by the storage layer. */
  id: string;
  requestId: string;
  taskId: string;
  executionId: string;
  transcript: string;
  intent: StructuredIntent | null;
  plan: ExecutionPlan | null;
  agentProviderId: string | null;
  steps: StepResult[];
  verification: { passed: boolean; detail: string };
  retries: number;
  errors: string[];
  latencyMs: number;
  status: TaskStatus;
  startedAt: number;
  completedAt: number;
  summary: string;
}

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

export interface MemoryEntry {
  id: string;
  kind: 'identity' | 'preference' | 'project' | 'task_history' | 'workflow' | 'fact' | 'tool_knowledge' | 'workspace_context' | 'conversation';
  content: string;
  tags: string[];
  score: number;
  timestamp: number;
  source?: string;
}

// ---------------------------------------------------------------------------
// Voice
// ---------------------------------------------------------------------------

export type VoiceState = 'IDLE' | 'LISTENING' | 'REASONING' | 'SPEAKING' | 'PROCESSING';
export type VoiceEvent = 'wake' | 'utterance_start' | 'utterance_end' | 'barge_in' | 'speech' | 'error' | 'finalized';

// ---------------------------------------------------------------------------
// Telemetry
// ---------------------------------------------------------------------------

export interface TelemetrySample {
  ts: number;
  category: string;
  metric: string;
  valueMs: number;
  ok: boolean;
  extra?: Record<string, unknown>;
}

export interface EngineTelemetry {
  requestLatencyMs: number;
  planningLatencyMs: number;
  providerLatencyMs: number;
  toolLatencyMs: number;
  forgeLatencyMs: number;
  sandboxLatencyMs: number;
  verificationLatencyMs: number;
  overallTaskMs: number;
  successRate: number;
  retryCount: number;
}
