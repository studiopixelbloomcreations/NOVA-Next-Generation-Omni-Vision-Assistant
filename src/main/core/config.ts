// src/main/core/config.ts
// Centralized configuration for the NOVA Genesis desktop OS.
// Every tunable lives here; runtime values come from environment variables
// (optionally overridden by the SecretStore at boot) with sane defaults.
import { join } from 'path';
import { app } from 'electron';

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export const NovaConfig = {
  /** AI provider wiring. Providers are swappable at runtime. */
  ai: {
    /** Live-conversation model used by the Gemini Live bridge. */
    liveModel: process.env.NOVA_LIVE_MODEL || 'models/gemini-2.5-flash-native-audio-preview-12-2025',
    /** Model used for tool/code generation when the Live session is not available. */
    codegenModel: process.env.NOVA_CODEGEN_MODEL || 'models/gemini-2.5-pro',
    /**
     * Canonical Gemini Live Native Audio voice — SINGLE source of truth. The
     * Live bridge reads this value when building the session setup frame; no
     * other voice configuration exists (Charon: controlled, informative,
     * authoritative).
     */
    liveVoice: process.env.NOVA_LIVE_VOICE || 'Charon',
    /** Provider priority list. First *configured* provider wins. */
    providerPriority: (process.env.NOVA_PROVIDER_PRIORITY || 'gemini,groq').split(',').map(s => s.trim()),
    requestTimeoutMs: intFromEnv('NOVA_AI_TIMEOUT_MS', 30000),
  },

  tooling: {
    /** Sandbox memory cap (MB) for generated tools. */
    sandboxMemoryMb: intFromEnv('NOVA_SANDBOX_MEMORY_MB', 64),
    /** Sandbox execution timeout (ms) for a single tool invocation. */
    executionTimeoutMs: intFromEnv('NOVA_TOOL_TIMEOUT_MS', 2000),
    /** Maximum source size for a generated tool (bytes). */
    maxSourceBytes: intFromEnv('NOVA_TOOL_MAX_BYTES', 64 * 1024),
    /** Success-rate below which a tool is marked unhealthy (0..1). */
    healthThreshold: 0.5,
    /** Max versions retained per tool for rollback support. */
    maxVersionsPerTool: intFromEnv('NOVA_TOOL_MAX_VERSIONS', 8),
    /** Directory (under userData) where generated tool source lives. */
    toolsDirName: 'tools',
    /** Enforce permission contracts at execution time (defense in depth). */
    enforcePermissions: process.env.NOVA_ENFORCE_PERMISSIONS !== 'false',
    /** NOVA is action-first: clear requests execute without an approval prompt. */
    requireApprovalForSynthesis: false,
    /**
     * Execute generated tools in a dedicated child process with a hard
     * wall-clock kill. When false, sandboxed execution is disabled entirely
     * (the in-process path was removed because it cannot preempt runaway loops).
     */
    workerIsolation: process.env.NOVA_TOOL_WORKER !== 'false',
    /** Extra budget (ms) beyond executionTimeoutMs before the worker is SIGKILLed. */
    workerGraceMs: intFromEnv('NOVA_TOOL_WORKER_GRACE_MS', 1000),
  },

  security: {
    /**
     * Hosts the httpJsonControl builtins (smart lights, printers) may target.
     * Loopback is always allowed; anything else must be listed here or via
     * NOVA_CONTROL_HOSTS (comma-separated). Blocks SSRF into the LAN.
     */
    controlHosts: (process.env.NOVA_CONTROL_HOSTS || 'localhost,127.0.0.1,::1')
      .split(',')
      .map(h => h.trim().toLowerCase())
      .filter(Boolean),
    /** Ports the control builtins may connect to. */
    controlPorts: (process.env.NOVA_CONTROL_PORTS || '80,443,8080,8443,9100,515,631')
      .split(',')
      .map(p => Number.parseInt(p.trim(), 10))
      .filter(p => Number.isFinite(p) && p > 0 && p <= 65535),
  },

  python: {
    /** Where the NOVA Python backend package lives in the repo. */
    packageRoot: process.env.NOVA_PYTHON_PACKAGE || '',
    /** Root directories the Python filesystem service may access. */
    allowedRoots: (process.env.NOVA_PYTHON_ROOTS || '').split(';').filter(Boolean),
    /** Worker request timeout (ms). */
    requestTimeoutMs: intFromEnv('NOVA_PYTHON_TIMEOUT_MS', 20000),
  },

  context: {
    /** Foreground-window poll interval (ms). */
    pollIntervalMs: intFromEnv('NOVA_CONTEXT_POLL_MS', 5000),
  },

  telemetry: {
    broadcastHz: 1,
    /** Only broadcast telemetry while the window is visible. */
    pauseWhenHidden: true,
  },

  ingestion: {
    /** Wake-word fallback RMS threshold (16-bit PCM). */
    wakeWordRmsThreshold: intFromEnv('PICOVOICE_FALLBACK_THRESHOLD', 1500),
    /** Screen delta capture rate (fps). */
    captureFrameRate: 2,
  },

  windows: {
    /** Default window size on first launch. */
    windowWidth: 1280,
    windowHeight: 800,
    backgroundColor: '#020205',
  },

  paths: {
    get userData(): string {
      try {
        // Under plain Node (headless tests/CI) the Electron `app` module is a
        // path string, not an object — getPath would throw. Fall back to a
        // local .nova-data dir so the config is always resolvable.
        if (typeof (app as any)?.getPath === 'function') {
          return app.getPath('userData');
        }
        return join(process.cwd(), '.nova-data');
      } catch {
        return join(process.cwd(), '.nova-data');
      }
    },
    get ledgerDb(): string {
      return join(this.userData, 'interaction_ledger.db');
    },
    get graphDb(): string {
      return join(this.userData, 'knowledge_graph.db');
    },
    get registryDb(): string {
      return join(this.userData, 'tool_registry.db');
    },
    get toolsRoot(): string {
      return join(this.userData, NovaConfig.tooling.toolsDirName);
    },
    get workspaceDb(): string {
      return join(this.userData, 'nova.db');
    },
    get artifactsRoot(): string {
      return join(this.userData, 'artifacts');
    },
    get auditLog(): string {
      return join(this.userData, 'nova_audit.log');
    },
    get vaultPath(): string {
      return join(this.userData, 'secrets.vault');
    },
    /** Agent projects sandbox (kept for back-compat with agent_projects). */
    get projectsRoot(): string {
      return process.env.NOVA_PROJECTS_ROOT || join(app.getPath('documents'), 'nova_projects');
    },
  },
} as const;

export type NovaConfigType = typeof NovaConfig;
