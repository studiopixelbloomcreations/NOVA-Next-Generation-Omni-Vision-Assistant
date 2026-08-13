// New Backend — tools/BuiltinTools.ts
// Core built-in capabilities registered into the Execution Engine. These are
// audited host handlers — never arbitrary code. They cover real host actions
// and workspace presentation used by the planning/execution loop.
import { randomUUID } from 'node:crypto';
import type { BuiltinHandler } from '../execution/ExecutionEngine.js';
import { PythonRuntimeBridge } from '../execution/PythonRuntimeBridge.js';
import { WorkspaceEngine } from '../workspace/WorkspaceEngine.js';
import type { ToolLibrary } from '../persistence/tool_library.js';
import type { ToolDefinition } from '../contracts/domain.js';

export interface BuiltinContext {
  bridge: PythonRuntimeBridge;
  workspace: WorkspaceEngine;
}

/** Builtin capability metadata so Capability Discovery can find/reuse them. */
const BUILTIN_CAPABILITIES: Array<Pick<ToolDefinition, 'technicalId' | 'displayName' | 'description' | 'category' | 'capabilities'>> = [
  { technicalId: 'system_info', displayName: 'System Info', description: 'Reads host system information (OS, CPU, memory).', category: 'system', capabilities: ['SYSTEM_READ'] },
  { technicalId: 'list_processes', displayName: 'Process List', description: 'Lists running processes on the machine.', category: 'system', capabilities: ['PROCESS_READ'] },
  { technicalId: 'active_window', displayName: 'Window Insight', description: 'Reports the currently active window title and pid.', category: 'windows', capabilities: ['WINDOW_INSPECT'] },
  { technicalId: 'launch_app', displayName: 'App Launcher', description: 'Launches a real application on Windows.', category: 'windows', capabilities: ['APP_LAUNCH'] },
  { technicalId: 'screenshot', displayName: 'Screen Capture', description: 'Captures the real screen and presents it in the workspace.', category: 'windows', capabilities: ['SCREEN_CAPTURE'] },
  { technicalId: 'clipboard_read', displayName: 'Clipboard Reader', description: 'Reads the current clipboard text.', category: 'system', capabilities: ['CLIPBOARD'] },
  { technicalId: 'clipboard_write', displayName: 'Clipboard Writer', description: 'Writes text to the clipboard.', category: 'system', capabilities: ['CLIPBOARD'] },
  { technicalId: 'keyboard_type', displayName: 'Keyboard Type', description: 'Types text through the keyboard.', category: 'windows', capabilities: ['KEYBOARD'] },
  { technicalId: 'directory_analysis', displayName: 'Directory Analysis', description: 'Analyses a directory and reports the largest files.', category: 'files', capabilities: ['DIRECTORY_ANALYSIS'] },
  { technicalId: 'workspace_show', displayName: 'Workspace Presenter', description: 'Presents content inside the A.D.A.M. workspace.', category: 'workspace', capabilities: ['WORKSPACE'] },
];

/** Register builtin capabilities as system tools so discovery can find them. */
export function registerBuiltinCapabilities(library: ToolLibrary): void {
  for (const cap of BUILTIN_CAPABILITIES) {
    if (library.getByTechnicalId(cap.technicalId)) continue;
    const now = Date.now();
    const tool: ToolDefinition = {
      id: randomUUID(),
      technicalId: cap.technicalId,
      displayName: cap.displayName,
      description: cap.description,
      category: cap.category,
      author: 'system',
      version: '1.0.0',
      runtime: 'builtin',
      capabilities: cap.capabilities,
      permissions: [],
      dependencies: [],
      sourceHash: 'builtin-' + cap.technicalId,
      enabled: true,
      status: 'active',
      health: 'healthy',
      createdAt: now,
      updatedAt: now,
      lastExecutedAt: null,
      lastValidationDate: now,
      executionCount: 0,
      successCount: 0,
      totalExecutionTimeMs: 0,
      versions: [],
    };
    library.upsert(tool);
  }
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

  // --- Real Windows automation (System 10). These run through the approved
  // Python runtime against the real machine; never the sandbox. ---

  executor.registerBuiltin('active_window', async () => {
    const res = await ctx.bridge.winCmd<{ success?: boolean; title?: string; pid?: number; error?: string }>('active-window', {}, 10000);
    return res.ok && res.data?.success === true
      ? { success: true, title: res.data.title, pid: res.data.pid }
      : { success: false, error: res.data?.error ?? res.error ?? 'active window unavailable' };
  });

  executor.registerBuiltin('launch_app', async (params) => {
    const target = String(params.target ?? params.app ?? '');
    const res = await ctx.bridge.winCmd<{ success?: boolean; pid?: number; error?: string }>('launch', { target, args: params.args ?? '' }, 15000);
    return res.ok && res.data?.success === true
      ? { success: true, pid: res.data.pid }
      : { success: false, error: res.data?.error ?? res.error ?? 'app launch failed' };
  });

  executor.registerBuiltin('screenshot', async (params) => {
    const res = await ctx.bridge.winCmd<{ success?: boolean; dataBase64?: string; mime?: string; error?: string }>(
      'screenshot',
      { monitor: Number(params.monitor ?? 0), path: params.path ?? '' },
      20000,
    );
    if (res.ok && res.data?.success === true) {
      // Present the capture inside the A.D.A.M. workspace (workspace-first).
      if (res.data.dataBase64) {
        ctx.workspace.open({ type: 'image', title: 'Screen Capture', source: res.data.mime ?? 'image/png', content: `data:${res.data.mime ?? 'image/png'};base64,${res.data.dataBase64}` });
      }
      return { success: true, dataBase64: res.data.dataBase64, mime: res.data.mime };
    }
    return { success: false, error: res.data?.error ?? res.error ?? 'screenshot failed' };
  });

  executor.registerBuiltin('clipboard_read', async () => {
    const res = await ctx.bridge.winCmd<{ success?: boolean; text?: string }>('clipboard-read', {}, 8000);
    return res.ok && res.data?.success === true ? { success: true, text: res.data.text } : { success: false, error: 'clipboard read unavailable' };
  });

  executor.registerBuiltin('clipboard_write', async (params) => {
    const res = await ctx.bridge.winCmd<{ success?: boolean }>('clipboard-write', { text: params.text ?? '' }, 8000);
    return { success: res.ok && res.data?.success === true };
  });

  executor.registerBuiltin('keyboard_type', async (params) => {
    const res = await ctx.bridge.winCmd<{ success?: boolean; error?: string }>('keyboard-type', { text: params.text ?? '' }, 10000);
    return res.ok && res.data?.success === true ? { success: true } : { success: false, error: res.data?.error ?? 'keyboard unavailable' };
  });
}
