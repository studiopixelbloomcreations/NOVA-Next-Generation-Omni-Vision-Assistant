// src/main/services/tool_executor.ts
// Sandboxed executor for registered tools.
//
// Generated tools run in a dedicated child process (sandbox_worker.js) that is
// spawned once and reused. The host only exchanges JSON-serializable values
// over stdio, and every invocation is guarded by a hard wall-clock deadline:
// when a tool exceeds its budget — even with a synchronous infinite loop that
// no in-process timeout can preempt — the whole worker process is SIGKILLed
// and respawned on the next request. This closes the isolated-vm
// direct-call non-preemption gap.
//
// Built-in tools still execute in the main process as audited, permission-scoped
// host handlers; they never run arbitrary code.
import { EventEmitter } from 'events';
import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import { ToolDefinition, ToolExecutionResult } from './tool_types';
import { ToolRegistry } from './tool_registry';
import { NovaConfig } from '../core/config';
import { scrubEnv } from '../utils/security';
import { logger } from '../core/logger';
import { pythonRuntime } from './python_runtime';

interface WorkerResponse {
  id: number;
  ok: boolean;
  payload?: unknown;
  error?: string | null;
}

interface PendingRequest {
  resolve: (r: WorkerResponse) => void;
  timer: NodeJS.Timeout;
}

/**
 * Owns the sandbox worker child process: spawn, JSON-lines IPC, hard
 * wall-clock kill, and respawn on the next request.
 */
class SandboxWorker {
  private child: ChildProcess | null = null;
  private pending = new Map<number, PendingRequest>();
  private nextId = 1;
  private stdoutBuffer = '';
  private stopped = false;

  private scriptPath(): string {
    return path.join(__dirname, 'sandbox_worker.js');
  }

  private ensureSpawned(): boolean {
    if (this.stopped) return false;
    if (this.child && this.child.exitCode === null && !this.child.killed) return true;
    try {
      // Under Electron, process.execPath is the Electron binary; running it
      // with ELECTRON_RUN_AS_NODE makes it behave as plain Node so the worker
      // script executes without launching a second app window. Under plain
      // Node (unit tests) the flag is ignored.
      const child = spawn(process.execPath, [this.scriptPath()], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        env: { ...scrubEnv(), ELECTRON_RUN_AS_NODE: '1' },
      });
      this.child = child;
      this.stdoutBuffer = '';
      child.stdout?.on('data', (d: Buffer) => this.onWorkerData(d.toString()));
      child.stderr?.on('data', (d: Buffer) => {
        const line = d.toString().trim();
        if (line) logger.debug('[tool_executor] sandbox worker stderr', { line });
      });
      // These handlers close over `child`, not `this.child`, so a stale close
      // event from a worker that was SIGKILLed by the wall-clock timer can
      // never fail the next worker's pending requests or clobber its reference.
      child.once('error', err => {
        logger.warn('[tool_executor] sandbox worker spawn error', { error: err.message });
        if (this.child === child) {
          this.failPending(new Error(`sandbox worker failed: ${err.message}`));
          this.child = null;
        }
      });
      child.once('close', code => {
        logger.debug('[tool_executor] sandbox worker exited', { code });
        if (this.child === child) {
          this.failPending(new Error('sandbox worker exited'));
          this.child = null;
        }
      });
      return true;
    } catch (err) {
      logger.error('[tool_executor] sandbox worker spawn failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  /** Runs a tool in the worker under a hard wall-clock deadline. */
  public run(
    sourceCode: string,
    sourceHash: string,
    toolName: string,
    context: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<WorkerResponse> {
    if (!this.ensureSpawned() || !this.child || !this.child.stdin) {
      return Promise.resolve({ id: 0, ok: false, error: 'sandbox worker unavailable' });
    }
    const id = this.nextId++;
    return new Promise<WorkerResponse>(resolve => {
      // The wall-clock kill: budget + grace for IPC/compile latency, then the
      // entire worker process is terminated. A synchronous runaway loop dies
      // with it — this is the guarantee the in-process sandbox could not give.
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.killWorker();
        resolve({ id, ok: false, error: `Tool timed out after ${timeoutMs}ms` });
      }, timeoutMs + NovaConfig.tooling.workerGraceMs);
      this.pending.set(id, { resolve, timer });
      try {
        this.child!.stdin!.write(
          `${JSON.stringify({
            id,
            method: 'run',
            sourceCode,
            sourceHash,
            toolName,
            memoryMb: NovaConfig.tooling.sandboxMemoryMb,
            timeoutMs,
            context,
          })}\n`,
        );
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        resolve({ id, ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    });
  }

  private onWorkerData(chunk: string): void {
    this.stdoutBuffer += chunk;
    let newlineIdx: number;
    while ((newlineIdx = this.stdoutBuffer.indexOf('\n')) >= 0) {
      const line = this.stdoutBuffer.slice(0, newlineIdx).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIdx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line) as WorkerResponse;
        const entry = this.pending.get(msg.id);
        if (entry) {
          clearTimeout(entry.timer);
          this.pending.delete(msg.id);
          entry.resolve(msg);
        }
      } catch {
        logger.debug('[tool_executor] sandbox worker emitted non-JSON line', { line: line.slice(0, 120) });
      }
    }
  }

  private killWorker(): void {
    if (this.child) {
      try {
        this.child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      this.child = null;
    }
  }

  private failPending(err: Error): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.resolve({ id: 0, ok: false, error: err.message });
    }
    this.pending.clear();
  }

  /** Stops the worker (permanent — called on app shutdown). */
  public shutdown(): void {
    this.stopped = true;
    this.failPending(new Error('sandbox worker stopped'));
    this.killWorker();
  }
}

export type BuiltinHandler = (args: Record<string, unknown>) => Promise<unknown> | unknown;

export class ToolExecutor extends EventEmitter {
  private registry: ToolRegistry;
  /** Handlers for built-in tools (entryPoint === 'builtin'). */
  private builtinHandlers = new Map<string, BuiltinHandler>();
  private sandboxWorker: SandboxWorker | null = null;

  constructor(registry: ToolRegistry, builtinHandlers?: Record<string, BuiltinHandler>) {
    super();
    this.registry = registry;
    if (builtinHandlers) {
      for (const [name, handler] of Object.entries(builtinHandlers)) {
        this.builtinHandlers.set(name, handler);
      }
    }
  }

  public registerBuiltin(name: string, handler: BuiltinHandler): void {
    this.builtinHandlers.set(name, handler);
  }

  /** The worker-based sandbox is available unless process isolation is off. */
  public isSandboxAvailable(): boolean {
    return NovaConfig.tooling.workerIsolation;
  }

  private getWorker(): SandboxWorker {
    if (!this.sandboxWorker) this.sandboxWorker = new SandboxWorker();
    return this.sandboxWorker;
  }

  /** Executes a tool by registry id or name. */
  public async execute(
    idOrName: string,
    context: Record<string, unknown> = {},
  ): Promise<ToolExecutionResult> {
    const tool = this.registry.get(idOrName) ?? this.registry.getByName(idOrName);
    if (!tool) {
      return {
        toolId: idOrName,
        toolName: idOrName,
        success: false,
        payload: null,
        error: `Unknown tool: ${idOrName}`,
        durationMs: 0,
        timestamp: Date.now(),
      };
    }
    if (!tool.enabled) {
      return {
        toolId: tool.id,
        toolName: tool.name,
        success: false,
        payload: null,
        error: `Tool '${tool.name}' is disabled`,
        durationMs: 0,
        timestamp: Date.now(),
      };
    }
    return this.executeDefinition(tool, context);
  }

  /**
   * Enforces the tool's declared permission contract before execution.
   * Sandboxed tools have no host access at all, so any request for process,
   * native-module or unrestricted filesystem capability is rejected outright
   * (defense in depth even if the sandbox or its guards regress).
   */
  private checkPermissions(tool: ToolDefinition): string | null {
    if (!NovaConfig.tooling.enforcePermissions) return null;
    if (tool.entryPoint !== 'sandboxed-function') return null;
    for (const p of tool.permissions ?? []) {
      if (p.type === 'child-process' || p.type === 'native-module') {
        return `Tool '${tool.name}' requests banned permission '${p.type}' for sandboxed execution.`;
      }
      if (p.type === 'fs-write' && Array.isArray(p.scope) && p.scope.includes('*')) {
        return `Tool '${tool.name}' requests unrestricted filesystem write access; denied.`;
      }
    }
    return null;
  }

  /**
   * Forged Python tools run in PRODUCTION through the real Python runtime.
   * The sandbox is only for validation; real user-requested actions execute
   * here against the actual machine via the audited worker.
   */
  private async executePythonTool(
    tool: ToolDefinition,
    context: Record<string, unknown>,
  ): Promise<unknown> {
    if (!tool.sourcePath) {
      throw new Error(`Forged tool '${tool.name}' has no source path.`);
    }
    const result = await pythonRuntime.request(
      'forge.run',
      { tool_path: tool.sourcePath, params: context },
      30000,
    );
    if (!result.ok) {
      throw new Error(result.error ?? `Python tool '${tool.name}' failed`);
    }
    const data = result.data as { ok?: boolean; result?: unknown };
    const payload = data?.result ?? data;
    if (payload && typeof payload === 'object' && (payload as { success?: unknown }).success === false) {
      throw new Error(String((payload as { error?: unknown }).error ?? `Python tool '${tool.name}' reported failure`));
    }
    return payload;
  }

  public async executeDefinition(
    tool: ToolDefinition,
    context: Record<string, unknown> = {},
  ): Promise<ToolExecutionResult> {
    const started = Date.now();
    const permissionViolation = this.checkPermissions(tool);
    if (permissionViolation) {
      const result: ToolExecutionResult = {
        toolId: tool.id,
        toolName: tool.name,
        success: false,
        payload: null,
        error: permissionViolation,
        durationMs: 0,
        timestamp: Date.now(),
      };
      this.registry.recordExecution(tool.id, { success: false, durationMs: 0, error: permissionViolation });
      this.emit('tool-executed', { toolId: tool.id, success: false });
      return result;
    }
    try {
      let payload: unknown;
      if (tool.entryPoint === 'builtin') {
        // Built-in tools execute in the host process but are permission-scoped
        // and audited; they never run arbitrary code. A handler that returns
        // { success: false, error } reports a REAL failure (e.g. a path outside
        // the sandbox, an unavailable device) — it must not masquerade as a
        // successful tool run just because it did not throw.
        const handler = this.builtinHandlers.get(tool.name);
        if (!handler) {
          throw new Error(`Builtin handler not found for '${tool.name}'`);
        }
        payload = await handler(context);
        if (
          payload !== null &&
          typeof payload === 'object' &&
          (payload as { success?: unknown }).success === false
        ) {
          const errorText =
            (payload as { error?: unknown }).error ?? `${tool.name} reported failure`;
          throw new Error(typeof errorText === 'string' ? errorText : String(errorText));
        }
      } else if (tool.entryPoint === 'python') {
        // Forged Python tools execute in PRODUCTION through the real Python
        // runtime — the sandbox is for validation only, never for real actions.
        payload = await this.executePythonTool(tool, context);
      } else {
        if (!NovaConfig.tooling.workerIsolation) {
          throw new Error('Sandbox executor unavailable: worker isolation is disabled.');
        }
        // Process-isolated execution with a hard wall-clock kill.
        const response = await this.getWorker().run(
          tool.sourceCode,
          tool.sourceHash,
          tool.name,
          context,
          NovaConfig.tooling.executionTimeoutMs,
        );
        if (!response.ok) {
          throw new Error(response.error ?? 'sandbox execution failed');
        }
        payload = response.payload;
      }

      const result: ToolExecutionResult = {
        toolId: tool.id,
        toolName: tool.name,
        success: true,
        payload: this.toJsonSafe(payload),
        error: null,
        durationMs: Date.now() - started,
        timestamp: Date.now(),
      };
      this.registry.recordExecution(tool.id, { success: true, durationMs: result.durationMs });
      this.emit('tool-executed', { toolId: tool.id, success: true });
      return result;
    } catch (err) {
      const durationMs = Date.now() - started;
      const message =
        err instanceof Error
          ? this.mapSandboxError(err)
          : `Tool execution failed: ${String(err)}`;
      const result: ToolExecutionResult = {
        toolId: tool.id,
        toolName: tool.name,
        success: false,
        payload: null,
        error: message,
        durationMs,
        timestamp: Date.now(),
      };
      this.registry.recordExecution(tool.id, { success: false, durationMs, error: message });
      this.emit('tool-executed', { toolId: tool.id, success: false });
      return result;
    }
  }

  private mapSandboxError(err: Error): string {
    const msg = err.message ?? String(err);
    // Timeout errors (from the worker or the wall-clock kill) surface as-is.
    if (/timeout/i.test(msg)) return `Tool timed out after ${NovaConfig.tooling.executionTimeoutMs}ms`;
    return msg.length > 400 ? `${msg.slice(0, 400)}…` : msg;
  }

  private toJsonSafe(value: unknown): unknown {
    if (value === undefined || value === null) return value;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      return value;
    }
    try {
      return JSON.parse(JSON.stringify(value));
    } catch {
      return { error: 'Tool returned a non-serializable value' };
    }
  }

  /** Stops the sandbox worker (called on app shutdown). */
  public shutdown(): void {
    try {
      this.sandboxWorker?.shutdown();
    } catch (err) {
      logger.error('[tool_executor] sandbox worker shutdown failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

export const createToolExecutor = (registry: ToolRegistry): ToolExecutor =>
  new ToolExecutor(registry);
