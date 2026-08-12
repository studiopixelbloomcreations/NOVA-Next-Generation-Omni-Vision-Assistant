// New Backend — core/config.ts
// Self-contained configuration for the New Backend. It resolves its own data
// directories and is Electron-safe (falls back to a local `.nova2-data` dir
// when run under plain Node for tests/CI).
import { join } from 'node:path';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function boolFromEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return raw !== 'false' && raw !== '0';
}

/** Minimal Electron-detection helper (avoids importing Electron under Node). */
export function isElectron(): boolean {
  return (
    typeof process !== 'undefined' &&
    Boolean((process as { versions?: Record<string, unknown> }).versions?.electron)
  );
}

function resolveUserData(): string {
  if (isElectron()) {
    // Electron exposes app.getPath('userData'); imported lazily to keep this
    // module runnable in plain Node.
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const electron = (globalThis as Record<string, unknown>).require
        ? (globalThis as unknown as { require: (m: string) => { app?: { getPath?: (p: string) => string } } }).require('electron')
        : null;
      const p = electron?.app?.getPath?.('userData');
      if (typeof p === 'string' && p) return p;
    } catch {
      /* fall through */
    }
  }
  return join(process.cwd(), '.nova2-data');
}

/** Resolve the python_runtime package root independent of module system.
 * Strategies, first match wins: env override -> cwd conventions -> Electron
 * resources -> walk up from cwd. This works for ESM and CJS builds and for
 * dev/packaged layouts without import.meta/__dirname. */
function resolvePythonRuntimeRoot(): string {
  const candidates: string[] = [];
  const envRoot = process.env.NOVA2_PYTHON_RUNTIME_ROOT;
  if (envRoot) candidates.push(envRoot);
  const cwd = process.cwd();
  candidates.push(join(cwd, 'python_runtime'));
  candidates.push(join(cwd, 'New Backend', 'python_runtime'));
  candidates.push(join(cwd, 'nova2', 'python_runtime'));
  const resources = (process as { resourcesPath?: string }).resourcesPath;
  if (resources) {
    candidates.push(join(resources, 'app', 'python_runtime'));
    candidates.push(join(resources, 'app', 'New Backend', 'python_runtime'));
  }
  // Walk up from cwd a few levels looking for a python_runtime package.
  let base = cwd;
  for (let i = 0; i < 5; i++) {
    candidates.push(join(base, 'python_runtime'));
    base = join(base, '..');
  }
  for (const c of candidates) {
    if (existsSync(join(c, 'nova_runtime', '__init__.py'))) return c;
  }
  return envRoot || join(cwd, 'python_runtime');
}

export const Nova2Config = {
  app: { name: 'NOVA Genesis', version: '2.0.0' },
  paths: {
    get userData(): string {
      return resolveUserData();
    },
    get toolsRoot(): string {
      return join(this.userData, 'tools');
    },
    get memoryDb(): string {
      return join(this.userData, 'memory.db');
    },
    get ledgerDb(): string {
      return join(this.userData, 'ledger.db');
    },
    get settingsFile(): string {
      return join(this.userData, 'settings.json');
    },
    get vaultPath(): string {
      return join(this.userData, 'secrets.vault');
    },
    get pythonRuntimeRoot(): string {
      return resolvePythonRuntimeRoot();
    },
  },
  providers: {
    priority: (process.env.NOVA2_PROVIDER_PRIORITY || 'groq,gemini').split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
    groqModel: process.env.NOVA2_GROQ_MODEL || 'llama-3.3-70b-versatile',
    geminiCodegenModel: process.env.NOVA2_GEMINI_CODEGEN_MODEL || 'models/gemini-2.5-pro',
    geminiLiveModel: process.env.NOVA2_GEMINI_LIVE_MODEL || 'models/gemini-2.5-flash-native-audio-preview-12-2025',
    liveVoice: process.env.NOVA2_LIVE_VOICE || 'Charon',
    requestTimeoutMs: intFromEnv('NOVA2_AI_TIMEOUT_MS', 30000),
  },
  forge: {
    maxRepairAttempts: intFromEnv('NOVA2_FORGE_REPAIR_ATTEMPTS', 3),
    maxSourceBytes: intFromEnv('NOVA2_FORGE_MAX_BYTES', 32 * 1024),
    sandboxTestTimeoutMs: intFromEnv('NOVA2_SANDBOX_TIMEOUT_MS', 30000),
    productionTimeoutMs: intFromEnv('NOVA2_PROD_TIMEOUT_MS', 30000),
    pythonExecutable: process.env.NOVA2_PYTHON_PATH || (process.platform === 'win32' ? 'python' : 'python3'),
    minRepairDelayMs: intFromEnv('NOVA2_REPAIR_DELAY_MS', 0),
  },
  execution: {
    maxRetriesPerStep: intFromEnv('NOVA2_MAX_RETRIES', 3),
    planTimeoutMs: intFromEnv('NOVA2_PLAN_TIMEOUT_MS', 20000),
    maxPlanSteps: intFromEnv('NOVA2_MAX_PLAN_STEPS', 12),
    workerRestartBackoffMs: intFromEnv('NOVA2_WORKER_BACKOFF_MS', 500),
    workerRestartMaxMs: intFromEnv('NOVA2_WORKER_BACKOFF_MAX_MS', 10000),
  },
  security: {
    enforcePermissions: boolFromEnv('NOVA2_ENFORCE_PERMISSIONS', true),
    secretScrubPatterns: ['API_KEY', 'SECRET', 'TOKEN', 'PASSWORD', 'PICOVOICE'],
    allowedHostRoots: ['Desktop', 'Documents', 'Downloads'],
  },
  memory: {
    maxRetrieval: intFromEnv('NOVA2_MEMORY_RETRIEVAL', 8),
    maxEntries: intFromEnv('NOVA2_MEMORY_MAX', 2000),
  },
  telemetry: { enabled: boolFromEnv('NOVA2_TELEMETRY', true) },
  workspace: {
    surfaceTypes: ['web', 'video', 'image', 'pdf', 'file', 'note', 'news', 'tool-result', 'code'] as const,
  },
  voice: { wakeWord: 'NOVA' },
  home: homedir(),
};

export type Nova2ConfigType = typeof Nova2Config;
