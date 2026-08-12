// New Backend — tools/BuiltinTools.ts
// Core built-in capabilities registered into the Execution Engine. These are
// audited host handlers — never arbitrary code. They cover real host actions
// and workspace presentation used by the planning/execution loop.
import type { BuiltinHandler } from '../execution/ExecutionEngine.js';
import { PythonRuntimeBridge } from '../execution/PythonRuntimeBridge.js';
import { WorkspaceEngine } from '../workspace/WorkspaceEngine.js';

export interface BuiltinContext {
  bridge: PythonRuntimeBridge;
  workspace: WorkspaceEngine;
}

export function registerBuiltins(executor: { registerBuiltin(name: string, handler: BuiltinHandler): void }, ctx: BuiltinContext): void {
  executor.registerBuiltin('system_info', async () => {
    const res = await ctx.bridge.systemInfo();
    return res.ok ? { success: true, ...(res.data as object) } : { success: false, error: res.error };
  });

  executor.registerBuiltin('list_processes', async (params) => {
    const res = await ctx.bridge.run('system-processes', { limit: Number(params.limit ?? 25) }, 10000);
    return res.ok ? { success: true, ...(res.data as object) } : { success: false, error: res.error };
  });

  executor.registerBuiltin('workspace_show', async (params) => {
    const type = String(params.type ?? 'note');
    const title = String(params.title ?? 'NOVA Result');
    const content = String(params.content ?? '');
    const surface = ctx.workspace.open({ type: type as never, title, source: content, content });
    return { success: true, surfaceId: surface.id, title, content };
  });

  executor.registerBuiltin('directory_analysis', async (params) => {
    const res = await ctx.bridge.run('fs-largest', { directory: String(params.directory ?? params.path ?? ''), n: Number(params.n ?? 5) }, 15000);
    return res.ok ? (res.data as object) : { success: false, error: res.error };
  });
}
