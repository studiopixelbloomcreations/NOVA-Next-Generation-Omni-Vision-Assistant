// src/main/core/config.ts
// Centralized configuration for the NOVA Genesis desktop OS.
import { join } from 'path';
import { app } from 'electron';

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export const NovaConfig = {
  ai: {
    liveModel: process.env.NOVA_LIVE_MODEL || 'models/gemini-2.5-flash-native-audio-preview-12-2025',
    codegenModel: process.env.NOVA_CODEGEN_MODEL || 'models/gemini-2.5-pro',
    liveVoice: process.env.NOVA_LIVE_VOICE || 'Charon',
    providerPriority: (process.env.NOVA_PROVIDER_PRIORITY || 'gemini,groq').split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
    requestTimeoutMs: intFromEnv('NOVA_AI_TIMEOUT_MS', 30000),
    groqModel: process.env.NOVA_GROQ_MODEL || 'llama-3.3-70b-versatile',
  },
  tooling: {
    sandboxMemoryMb: intFromEnv('NOVA_SANDBOX_MEMORY_MB', 64),
    executionTimeoutMs: intFromEnv('NOVA_TOOL_TIMEOUT_MS', 2000),
    maxSourceBytes: intFromEnv('NOVA_TOOL_MAX_BYTES', 64 * 1024),
    healthThreshold: 0.5,
    maxVersionsPerTool: intFromEnv('NOVA_TOOL_MAX_VERSIONS', 8),
    toolsDirName: process.env.NOVA_TOOLS_DIR_NAME || 'tools',
    enforcePermissions: process.env.NOVA_ENFORCE_PERMISSIONS !== 'false',
    requireApprovalForSynthesis: false,
    workerIsolation: process.env.NOVA_TOOL_WORKER !== 'false',
    workerGraceMs: intFromEnv('NOVA_TOOL_WORKER_GRACE_MS', 1000),
  },
  security: {
    controlHosts: (process.env.NOVA_CONTROL_HOSTS || 'localhost,127.0.0.1,::1').split(',').map(h => h.trim().toLowerCase()).filter(Boolean),
    controlPorts: (process.env.NOVA_CONTROL_PORTS || '80,443,8080,8443,9100,515,631').split(',').map(p => Number.parseInt(p.trim(), 10)).filter(p => Number.isFinite(p) && p > 0 && p <= 65535),
  },
  python: {
    packageRoot: process.env.NOVA_PYTHON_PACKAGE || '',
    allowedRoots: (process.env.NOVA_PYTHON_ROOTS || '').split(';').filter(Boolean),
    requestTimeoutMs: intFromEnv('NOVA_PYTHON_TIMEOUT_MS', 20000),
  },
  context: { pollIntervalMs: intFromEnv('NOVA_CONTEXT_POLL_MS', 5000) },
  telemetry: { broadcastHz: 1, pauseWhenHidden: true },
  ingestion: {
    wakeWordRmsThreshold: intFromEnv('PICOVOICE_FALLBACK_THRESHOLD', 1500),
    captureFrameRate: 2,
  },
  windows: { windowWidth: 1280, windowHeight: 800, backgroundColor: '#020205' },
  paths: {
    get userData(): string {
      try { if (typeof (app as any)?.getPath === 'function') return app.getPath('userData'); } catch { /* headless */ }
      return join(process.cwd(), '.nova-data');
    },
    get ledgerDb(): string { return join(this.userData, 'interaction_ledger.db'); },
    get graphDb(): string { return join(this.userData, 'knowledge_graph.db'); },
    get registryDb(): string { return join(this.userData, 'tool_registry.db'); },
    // NOVA tools are local and persistent. An explicit absolute override is
    // supported for development/testing; packaged builds default to the
    // Electron user-data directory so Windows remains writable.
    get toolsRoot(): string {
      const override = process.env.NOVA_TOOLS_ROOT?.trim();
      if (override) return override;
      return join(this.userData, NovaConfig.tooling.toolsDirName);
    },
    get workspaceDb(): string { return join(this.userData, 'nova.db'); },
    get artifactsRoot(): string { return join(this.userData, 'artifacts'); },
    get auditLog(): string { return join(this.userData, 'nova_audit.log'); },
    get vaultPath(): string { return join(this.userData, 'secrets.vault'); },
    get projectsRoot(): string {
      try { return process.env.NOVA_PROJECTS_ROOT || join(app.getPath('documents'), 'nova_projects'); }
      catch { return join(process.cwd(), 'nova_projects'); }
    },
  },
} as const;

export type NovaConfigType = typeof NovaConfig;
