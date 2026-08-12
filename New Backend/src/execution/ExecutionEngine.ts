// New Backend — execution/ExecutionEngine.ts
// Execution Engine. Executes registered tools in production through the real
// Python runtime. Built-in host handlers are audited; generated Python tools
// run through the approved runtime (never the sandbox for production). Every
// run is recorded in the ToolLibrary for health/success-rate tracking.
import type { ToolDefinition, ToolExecutionResult } from '../contracts/domain.js';
import { ToolLibrary } from '../persistence/tool_library.js';
import { PythonRuntimeBridge } from './PythonRuntimeBridge.js';
import { Nova2Config } from '../core/config.js';
import { logger } from '../core/logger.js';

export type BuiltinHandler = (params: Record<string, unknown>) => Promise<unknown> | unknown;

export class ExecutionEngine {
  private builtins = new Map<string, BuiltinHandler>();

  constructor(
    private readonly library: ToolLibrary,
    private readonly bridge: PythonRuntimeBridge,
  ) {}

  registerBuiltin(name: string, handler: BuiltinHandler): void {
    this.builtins.set(name, handler);
  }

  /** Execute by tool id, technicalId, or displayName. */
  async execute(idOrName: string, params: Record<string, unknown> = {}): Promise<ToolExecutionResult> {
    const tool = this.resolve(idOrName);
    if (!tool) {
      return { toolId: idOrName, toolName: idOrName, success: false, payload: null, error: `Unknown tool: ${idOrName}`, durationMs: 0, timestamp: Date.now(), attempts: 1 };
    }
    if (!tool.enabled) {
      return { toolId: tool.id, toolName: tool.displayName, success: false, payload: null, error: `Tool '${tool.displayName}' is disabled`, durationMs: 0, timestamp: Date.now(), attempts: 1 };
    }
    return this.executeTool(tool, params);
  }

  async executeTool(tool: ToolDefinition, params: Record<string, unknown>): Promise<ToolExecutionResult> {
    const started = Date.now();
    try {
      let payload: unknown;
      if (tool.runtime === 'builtin') {
        const handler = this.builtins.get(tool.technicalId);
        if (!handler) throw new Error(`Builtin handler not found for '${tool.technicalId}'`);
        payload = await handler(params);
        if (payload && typeof payload === 'object' && (payload as { success?: unknown }).success === false) {
          throw new Error(String((payload as { error?: unknown }).error ?? `${tool.displayName} reported failure`));
        }
      } else {
        // python / generated tools run in production through the approved runtime.
        if (!tool.sourcePath) throw new Error(`Tool '${tool.displayName}' has no source path`);
        payload = await this.bridge.executeToolOrThrow(tool.sourcePath, params, Nova2Config.forge.productionTimeoutMs);
      }
      const result: ToolExecutionResult = {
        toolId: tool.id,
        toolName: tool.displayName,
        success: true,
        payload: this.jsonSafe(payload),
        error: null,
        durationMs: Date.now() - started,
        timestamp: Date.now(),
        attempts: 1,
      };
      this.library.recordExecution(tool.id, { success: true, durationMs: result.durationMs });
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const result: ToolExecutionResult = {
        toolId: tool.id,
        toolName: tool.displayName,
        success: false,
        payload: null,
        error: message,
        durationMs: Date.now() - started,
        timestamp: Date.now(),
        attempts: 1,
      };
      this.library.recordExecution(tool.id, { success: false, durationMs: result.durationMs, error: message });
      logger.warn('[execution] tool execution failed', { tool: tool.displayName, error: message });
      return result;
    }
  }

  private resolve(idOrName: string): ToolDefinition | null {
    return (
      this.library.get(idOrName) ??
      this.library.getByTechnicalId(idOrName) ??
      this.library.getByName(idOrName)
    );
  }

  private jsonSafe(value: unknown): unknown {
    if (value === null || value === undefined) return value;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
    try {
      return JSON.parse(JSON.stringify(value));
    } catch {
      return { error: 'tool returned a non-serializable value' };
    }
  }
}
