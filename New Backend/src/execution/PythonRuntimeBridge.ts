// New Backend — execution/PythonRuntimeBridge.ts
// Bridge to the New Backend Python runtime. Spawns one-shot `python -m
// nova_runtime <mode>` invocations with a scrubbed environment and a hard
// timeout. Only the Execution Engine, Sandbox Runner and Tool Forge may use
// this bridge — no random module spawns Python directly.
import { spawn } from 'node:child_process';
import { Nova2Config } from '../core/config.js';
import { scrubEnv } from '../security/env_scrubber.js';
import { logger } from '../core/logger.js';
import { ToolExecutionFailureError } from '../core/errors.js';

export interface PythonResult<T = unknown> {
  ok: boolean;
  data: T | null;
  error: string | null;
}

export class PythonRuntimeBridge {
  private packageRoot: string;
  private executable: string;

  constructor() {
    this.packageRoot = Nova2Config.paths.pythonRuntimeRoot;
    this.executable = Nova2Config.forge.pythonExecutable;
  }

  run<T = unknown>(mode: string, params: Record<string, unknown>, timeoutMs: number): Promise<PythonResult<T>> {
    return new Promise(resolve => {
      let stdout = '';
      let stderr = '';
      let settled = false;
      const args = ['-m', 'nova_runtime', mode];

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child?.kill('SIGKILL');
        resolve({ ok: false, data: null, error: `python ${mode} timed out after ${timeoutMs}ms` });
      }, timeoutMs);

      let child: ReturnType<typeof spawn> | null = null;
      try {
        child = spawn(this.executable, args, {
          cwd: this.packageRoot,
          windowsHide: true,
          env: { ...scrubEnv(), NOVA_PYTHON_ROOT: this.packageRoot, PYTHONPATH: this.packageRoot },
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (err) {
        clearTimeout(timer);
        resolve({ ok: false, data: null, error: err instanceof Error ? err.message : String(err) });
        return;
      }

      child.stdin!.on('error', () => { /* EPIPE if child dies early */ });
      child.stdin!.write(JSON.stringify({ mode, params }) + '\n');
      child.stdin!.end();
      child.stdout!.on('data', d => { stdout += d.toString(); });
      child.stderr!.on('data', d => { stderr += d.toString(); });
      child.on('error', err => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ ok: false, data: null, error: err.message });
      });
      child.on('close', code => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const last = stdout.trim().split('\n').filter(Boolean).pop() ?? '';
        try {
          const parsed = JSON.parse(last);
          resolve({ ok: code === 0, data: parsed, error: code === 0 ? null : (stderr.trim().slice(0, 400) || 'python exited non-zero') });
        } catch {
          resolve({ ok: false, data: null, error: stderr.trim().slice(0, 400) || `python ${mode} produced non-JSON output` });
        }
      });
    });
  }

  /** Runs a forged tool's tests in the isolated sandbox. */
  sandboxTest(toolPath: string, testPath: string, timeoutMs: number): Promise<PythonResult<{ passed: boolean; output: string }>> {
    return this.run<{ passed: boolean; output: string }>('sandbox-test', { tool_path: toolPath, test_path: testPath, timeout_ms: timeoutMs }, timeoutMs + 10000);
  }

  /** Executes a registered tool's run(params) in production. */
  runTool(toolPath: string, params: Record<string, unknown>, timeoutMs: number): Promise<PythonResult<{ success: boolean; result?: unknown; error?: string }>> {
    return this.run<{ success: boolean; result?: unknown; error?: string }>('tool-run', { tool_path: toolPath, params }, timeoutMs);
  }

  /** Host/system introspection. */
  systemInfo(): Promise<PythonResult<unknown>> {
    return this.run('system-info', {}, 10000);
  }

  // -------------------------------------------------------------------------
  // Windows automation (System 10) + audio / voice (System 29) + Charon TTS
  // -------------------------------------------------------------------------

  /** Run a `win.*` command (active-window, launch, screenshot, process, clipboard, input). */
  winCmd<T = unknown>(cmd: string, params: Record<string, unknown> = {}, timeoutMs = 15000): Promise<PythonResult<T>> {
    return this.run<T>(`win.${cmd}`, params, timeoutMs);
  }

  /** Run an `audio.*` command (availability, devices, capture, transcribe). */
  audioCmd<T = unknown>(cmd: string, params: Record<string, unknown> = {}, timeoutMs = 30000): Promise<PythonResult<T>> {
    return this.run<T>(`audio.${cmd}`, params, timeoutMs);
  }

  /** Run a `tts.*` command (availability, speak, voices). */
  ttsCmd<T = unknown>(cmd: string, params: Record<string, unknown> = {}, timeoutMs = 30000): Promise<PythonResult<T>> {
    return this.run<T>(`tts.${cmd}`, params, timeoutMs);
  }

  /** Directory analysis (largest files). */
  largestFiles(directory: string, n: number): Promise<PythonResult<{ success: boolean; largest?: unknown; error?: string }>> {
    return this.run<{ success: boolean; largest?: unknown; error?: string }>('fs-largest', { directory, n }, 15000);
  }

  /** Executes a forged tool and throws on real failure (used by Execution Engine). */
  async executeToolOrThrow(toolPath: string, params: Record<string, unknown>, timeoutMs = Nova2Config.forge.productionTimeoutMs): Promise<unknown> {
    const result = await this.runTool(toolPath, params, timeoutMs);
    if (!result.ok) throw new ToolExecutionFailureError(result.error ?? 'python tool execution failed');
    const data = result.data as { success?: boolean; result?: unknown; error?: string } | null;
    if (data?.success === false) throw new ToolExecutionFailureError(data.error ?? 'tool reported failure');
    return data?.result ?? data;
  }

  async probeAvailability(): Promise<boolean> {
    try {
      const { execFileSync } = await import('node:child_process');
      execFileSync(this.executable, ['--version'], { timeout: 5000, stdio: 'ignore' });
      return true;
    } catch {
      logger.warn('[python_runtime] python interpreter unavailable', { executable: this.executable });
      return false;
    }
  }
}
