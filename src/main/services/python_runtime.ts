// src/main/services/python_runtime.ts
// Python Runtime bridge.
//
// NOVA delegates heavy automation, OCR and image-processing work to an external
// Python interpreter. Two modes:
//   1. Persistent worker — spawns `python -m nova_runtime --stdio` (the
//      stdlib-only package in python/) and talks JSON-RPC over stdio with
//      per-request timeouts, automatic restart with backoff, and concurrency
//      limits enforced inside the worker.
//   2. One-shot fallback — short JSON-over-stdout scripts (`runJson`) used when
//      the worker cannot start or for compatibility.
//
// Every spawn passes a scrubbed environment (no API keys) and a hard timeout.
// Nothing here ever executes Python from the tool sandbox; it is called
// exclusively by audited builtin tools and internal services.
import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { scrubEnv } from '../utils/security';
import { logger } from '../core/logger';
import { NovaConfig } from '../core/config';

export interface PythonRuntimeStatus {
  available: boolean;
  version: string;
  executable: string;
  modules: Record<string, boolean>;
  lastError: string | null;
  /** True when the persistent stdio worker is currently alive. */
  workerAlive: boolean;
}

const AVAILABILITY_TTL_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 15_000;
const WORKER_REQUEST_TIMEOUT_MS = 20_000;
const RESTART_BACKOFF_MS = 500;
const RESTART_BACKOFF_MAX_MS = 10_000;

interface PendingRequest {
  resolve: (data: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * Resolves the python/ package root without touching electron (Node-testable).
 * Candidates, in order:
 *   1. NOVA_PYTHON_PACKAGE env override.
 *   2. <cwd>/python            — dev tree.
 *   3. <resources>/app/python  — packaged Electron app (asar: false bundles
 *      python/ inside the app directory; process.cwd() is arbitrary there).
 *   4. <__dirname>/../../..    — dist/main/services up to the app root; matches
 *      both the dev tree (<root>/python) and the packaged app dir.
 */
function resolvePackageRoot(): string {
  const fromEnv = NovaConfig.python.packageRoot;
  if (fromEnv && fs.existsSync(path.join(fromEnv, 'nova_runtime'))) return fromEnv;
  const resourcesPath = (process as { resourcesPath?: string }).resourcesPath;
  if (resourcesPath) {
    const packagedCandidate = path.join(resourcesPath, 'app', 'python');
    if (fs.existsSync(path.join(packagedCandidate, 'nova_runtime'))) return packagedCandidate;
  }
  const cwdCandidate = path.join(process.cwd(), 'python');
  if (fs.existsSync(path.join(cwdCandidate, 'nova_runtime'))) return cwdCandidate;
  const appCandidate = path.join(__dirname, '..', '..', '..', 'python');
  if (fs.existsSync(path.join(appCandidate, 'nova_runtime'))) return appCandidate;
  return fromEnv || cwdCandidate;
}

export class PythonRuntime {
  private executable: string;
  private packageRoot: string;
  private statusCache: { at: number; status: PythonRuntimeStatus } | null = null;

  // Persistent worker state.
  private child: ChildProcess | null = null;
  private pending = new Map<number, PendingRequest>();
  private nextId = 1;
  private stdoutBuffer = '';
  private stopping = false;
  private stopped = false;
  private restartTimer: NodeJS.Timeout | null = null;
  // Several boot services (Whisper, microphone discovery, and workspace
  // initialization) can request the worker concurrently. Serialize startup
  // so two children are never spawned and one cannot orphan the other.
  private startPromise: Promise<boolean> | null = null;
  private restartDelay = RESTART_BACKOFF_MS;

  constructor(executable?: string) {
    this.executable =
      executable ??
      process.env.NOVA_PYTHON_PATH ??
      (process.platform === 'win32' ? 'python' : 'python3');
    this.packageRoot = resolvePackageRoot();
  }

  // ---------------------------------------------------------------------------
  // One-shot mode (kept as fallback and for the status probe)
  // ---------------------------------------------------------------------------

  private run(args: string[], timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise(resolve => {
      let stdout = '';
      let stderr = '';
      let settled = false;
      let child: ChildProcess | null = null;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          child?.kill('SIGKILL');
        } catch {
          /* ignore */
        }
        resolve({ code: -1, stdout, stderr: `timed out after ${timeoutMs}ms` });
      }, timeoutMs);

      try {
        child = spawn(this.executable, args, { windowsHide: true, env: scrubEnv() });
      } catch (err) {
        clearTimeout(timer);
        resolve({ code: -1, stdout, stderr: err instanceof Error ? err.message : String(err) });
        return;
      }

      child.stdout?.on('data', d => {
        stdout += d.toString();
      });
      child.stderr?.on('data', d => {
        stderr += d.toString();
      });
      child.once('error', err => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ code: -1, stdout, stderr: err.message });
      });
      child.once('close', code => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ code: code ?? -1, stdout, stderr });
      });
    });
  }

  /** Probes interpreter availability and required modules (cached). */
  public async status(force = false): Promise<PythonRuntimeStatus> {
    if (!force && this.statusCache && Date.now() - this.statusCache.at < AVAILABILITY_TTL_MS) {
      return this.statusCache.status;
    }

    const modules = ['PIL', 'pytesseract', 'cv2', 'numpy'];
    const probe =
      'import sys, json\n' +
      'mods = {}\n' +
      `for m in ${JSON.stringify(modules)}:\n` +
      '    try:\n' +
      '        __import__(m)\n' +
      '        mods[m] = True\n' +
      '    except Exception:\n' +
      '        mods[m] = False\n' +
      'print(json.dumps({"version": sys.version.split()[0], "modules": mods}))';

    const result = await this.run(['-c', probe], DEFAULT_TIMEOUT_MS);
    let version = '';
    let mods: Record<string, boolean> = {};
    if (result.code === 0) {
      const lastLine = result.stdout.trim().split('\n').filter(Boolean).pop() ?? '';
      try {
        const parsed = JSON.parse(lastLine);
        version = String(parsed.version ?? '');
        mods = parsed.modules ?? {};
      } catch {
        /* unparseable */
      }
    }

    const status: PythonRuntimeStatus = {
      available: result.code === 0,
      version,
      executable: this.executable,
      modules: mods,
      lastError: result.code === 0 ? null : result.stderr.trim().slice(0, 300),
      workerAlive: this.isWorkerAlive(),
    };
    this.statusCache = { at: Date.now(), status };
    return status;
  }

  public async hasModule(moduleName: string): Promise<boolean> {
    const s = await this.status();
    return s.modules[moduleName] === true;
  }

  /**
   * Runs a Python script (as `-c`) with optional positional args. The script
   * should print one final JSON object on stdout, which is parsed and returned.
   */
  public async runJson(
    script: string,
    args: string[] = [],
    timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ): Promise<{ ok: boolean; data: unknown; error: string | null }> {
    const s = await this.status();
    if (!s.available) {
      return { ok: false, data: null, error: 'Python runtime unavailable' };
    }
    const result = await this.run(['-c', script, ...args], timeoutMs);
    if (result.code !== 0) {
      return { ok: false, data: null, error: result.stderr.trim().slice(0, 400) || 'python exited non-zero' };
    }
    const lastLine = result.stdout.trim().split('\n').filter(Boolean).pop() ?? '';
    try {
      return { ok: true, data: JSON.parse(lastLine), error: null };
    } catch {
      return { ok: false, data: null, error: 'python output was not JSON' };
    }
  }

  // ---------------------------------------------------------------------------
  // Persistent worker mode
  // ---------------------------------------------------------------------------

  public isWorkerAlive(): boolean {
    return this.child !== null && this.child.exitCode === null && !this.stopping;
  }

  /** Starts the persistent worker (idempotent). Returns false when Python is missing. */
  public async startWorker(): Promise<boolean> {
    if (this.isWorkerAlive()) return true;
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.startWorkerInternal();
    try {
      return await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  private async startWorkerInternal(): Promise<boolean> {
    if (this.stopped) return false; // permanently stopped (shutdown)
    if (this.isWorkerAlive()) return true;
    if (!fs.existsSync(path.join(this.packageRoot, 'nova_runtime', '__main__.py'))) {
      logger.debug('[python_runtime] nova_runtime package not found; worker disabled', {
        packageRoot: this.packageRoot,
      });
      return false;
    }
    const s = await this.status(true);
    if (!s.available) return false;

    this.stopping = false;
    try {
      const allowedRoots = NovaConfig.python.allowedRoots;
      const toolsRoot = NovaConfig.paths.toolsRoot;
      // Default sandbox root for the worker's filesystem service: the python
      // package itself (exists in dev and packaged; process.cwd() is not a
      // reliable default once packaged). The NOVA tools root is appended so
      // the Tool Forge can read/write forged tools inside the worker.
      const roots = allowedRoots.length > 0 ? allowedRoots : [this.packageRoot];
      if (!roots.some(r => r.toLowerCase() === toolsRoot.toLowerCase())) {
        roots.push(toolsRoot);
      }
      const env: NodeJS.ProcessEnv = {
        ...scrubEnv(),
        PYTHONPATH: this.packageRoot,
        NOVA_PYTHON_ROOTS: roots.join(';'),
        NOVA_TOOLS_ROOT: toolsRoot,
        NOVA_PYTHON_LOG_LEVEL: process.env.NOVA_LOG_LEVEL === 'debug' ? 'debug' : 'info',
      };
      this.child = spawn(this.executable, ['-m', 'nova_runtime', '--stdio'], {
        cwd: this.packageRoot,
        windowsHide: true,
        env,
      });
      this.stdoutBuffer = '';
      this.child.stdout?.on('data', d => this.onWorkerData(d.toString()));
      this.child.stderr?.on('data', d => {
        const line = d.toString().trim();
        if (line) logger.debug('[python_runtime] worker stderr', { line });
      });
      this.child.once('error', err => {
        logger.warn('[python_runtime] worker spawn error', { error: err.message });
        this.rejectAllPending(new Error('python worker failed to start'));
        this.child = null;
        this.scheduleRestart();
      });
      this.child.once('close', code => {
        logger.warn('[python_runtime] worker exited', { code });
        this.rejectAllPending(new Error(`python worker exited (code ${code})`));
        this.child = null;
        if (!this.stopping) this.scheduleRestart();
      });
      // Recovery succeeded — reset the backoff so future restarts start fast.
      this.restartDelay = RESTART_BACKOFF_MS;
      logger.info('[python_runtime] persistent worker started', {
        executable: this.executable,
        packageRoot: this.packageRoot,
      });
      return true;
    } catch (err) {
      logger.error('[python_runtime] worker start failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  private onWorkerData(chunk: string): void {
    this.stdoutBuffer += chunk;
    let newlineIdx: number;
    while ((newlineIdx = this.stdoutBuffer.indexOf('\n')) >= 0) {
      const line = this.stdoutBuffer.slice(0, newlineIdx).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIdx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line) as { id?: number; result?: unknown; error?: { message?: string } };
        const id = msg.id;
        if (id !== undefined) {
          const entry = this.pending.get(id);
          if (entry) {
            clearTimeout(entry.timer);
            this.pending.delete(id);
            if (msg.error) {
              entry.reject(new Error(msg.error.message ?? 'python worker error'));
            } else {
              entry.resolve(msg.result);
            }
          }
        }
      } catch {
        logger.debug('[python_runtime] worker emitted non-JSON line', { line: line.slice(0, 120) });
      }
    }
  }

  private scheduleRestart(): void {
    if (this.stopping || this.restartTimer) return;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      void this.startWorker().catch(() => undefined);
    }, this.restartDelay);
    this.restartDelay = Math.min(this.restartDelay * 2, RESTART_BACKOFF_MAX_MS);
  }

  private rejectAllPending(err: Error): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
    this.pending.clear();
  }

  /**
   * Sends a JSON-RPC request to the persistent worker. Starts the worker
   * lazily; falls back to an error result when the worker cannot run.
   */
  public async request(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs: number = WORKER_REQUEST_TIMEOUT_MS,
  ): Promise<{ ok: boolean; data: unknown; error: string | null }> {
    const started = await this.startWorker();
    if (!started || !this.child || !this.child.stdin) {
      return { ok: false, data: null, error: 'Python worker unavailable' };
    }
    const id = this.nextId++;
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ ok: false, data: null, error: `python worker request timed out after ${timeoutMs}ms` });
      }, timeoutMs);
      this.pending.set(id, {
        resolve: data => resolve({ ok: true, data, error: null }),
        reject: err => {
          clearTimeout(timer);
          resolve({ ok: false, data: null, error: err.message });
        },
        timer,
      });
      try {
        this.child!.stdin!.write(`${JSON.stringify({ id, method, params })}\n`);
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        resolve({ ok: false, data: null, error: err instanceof Error ? err.message : String(err) });
      }
    });
  }

  /** Stops the persistent worker (called on app shutdown). Permanent. */
  public stopWorker(): void {
    this.stopping = true;
    this.stopped = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    this.rejectAllPending(new Error('python worker stopped'));
    if (this.child) {
      try {
        this.child.kill('SIGTERM');
      } catch {
        /* ignore */
      }
      this.child = null;
    }
  }
}

export const pythonRuntime = new PythonRuntime();
