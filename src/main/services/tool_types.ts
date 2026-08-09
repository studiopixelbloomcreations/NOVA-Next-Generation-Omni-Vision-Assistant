// src/main/services/tool_types.ts
// Canonical types shared by the Tool Registry, Tool Validator, Tool Executor,
// and Tool Builder. Every generated or built-in tool is described by ToolDefinition.

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
  /** Scopes: paths (fs), URL hosts (net), or '*' for broad access. */
  scope: string[];
}

export type ToolStatus = 'pending' | 'compiled' | 'failed' | 'disabled' | 'active';

export interface ToolVersion {
  version: string;
  sourceHash: string;
  sourceCode: string;
  createdAt: number;
  validation: {
    passed: boolean;
    violations: string[];
    testedAt: number;
  };
}

export type ToolRuntime = 'sandboxed-function' | 'python' | 'builtin';

export interface ToolDefinition {
  /** Unique id (uuid). */
  id: string;
  /** Human-readable display name (AI-chosen for forged tools, e.g. "Vision Capture"). */
  name: string;
  /** Stable machine identifier for forged tools (e.g. `vision_capture`). */
  technicalId?: string;
  description: string;
  category: string;
  author: 'system' | 'user' | 'ai';
  version: string;
  /** Declared dependencies (npm / runtime module names). */
  dependencies: string[];
  /**
   * Entry point — how the tool is invoked.
   *  - 'sandboxed-function': generated JS, executed only inside the sandbox
   *    worker (validation/tests).
   *  - 'python': forged Python tool, executed in PRODUCTION through the real
   *    NOVA Python runtime (the sandbox never runs production actions).
   *  - 'builtin': audited host handler.
   */
  entryPoint: ToolRuntime;
  /** Absolute path to the forged .py source (entryPoint 'python'). */
  sourcePath?: string;
  /** Declared capabilities (SCREEN_CAPTURE, WINDOW_INSPECT, ...). */
  capabilities?: string[];
  /** Config passed to the function as `context`. */
  config: Record<string, unknown>;
  permissions: ToolPermission[];
  /** Source of the tool (JS function body for sandboxed, Python source for forged). */
  sourceCode: string;
  /** SHA-256 of sourceCode. */
  sourceHash: string;
  enabled: boolean;
  status: ToolStatus;
  createdAt: number;
  updatedAt: number;
  lastExecutedAt: number | null;
  lastValidationDate: number | null;
  executionCount: number;
  successCount: number;
  totalExecutionTimeMs: number;
  /** Rolling health derived from success rate + recency. */
  health: 'healthy' | 'degraded' | 'unhealthy' | 'unknown';
  /** Historical versions kept for rollback. */
  versions: ToolVersion[];
}

export interface ToolExecutionResult {
  toolId: string;
  toolName: string;
  success: boolean;
  /** JSON-serializable value returned by the sandboxed function. */
  payload: unknown;
  error: string | null;
  durationMs: number;
  timestamp: number;
}

export interface ValidationViolation {
  code: string;
  severity: 'error' | 'warning';
  message: string;
}

export interface ValidationReport {
  passed: boolean;
  violations: ValidationViolation[];
  testedAt: number;
  /** Permissions inferred from static analysis of the source. */
  inferredPermissions: ToolPermission[];
}

export type ToolSynthesisPhase =
  | 'IDLE'
  | 'SEARCHING_REGISTRY'
  | 'TOOL_NOT_FOUND'
  | 'DESIGNING_ARCHITECTURE'
  | 'WRITING_CODE'
  | 'AWAITING_APPROVAL'
  | 'COMPILING_ASSETS'
  | 'RUNNING_SANITY_TESTS'
  | 'DEPLOYING_TOOL'
  | 'COMPLETED'
  | 'FAILED';

export interface BuildOptions {
  /** Requested capability description (free text from the model/user). */
  intent: string;
  /** Expected output shape hint, e.g. { streamUrl: 'string' }. */
  schema?: Record<string, string>;
  /** Hard permissive scopes granted to the generated tool. */
  permissions?: ToolPermission[];
  /** When true, prefers generating a live-stream widget for media intents. */
  preferStreamWidget?: boolean;
  /** When true, pauses synthesis for explicit approval before registration. */
  requireApproval?: boolean;
}

export interface ToolCreationRequest {
  intent: string;
  options?: Partial<BuildOptions>;
}
