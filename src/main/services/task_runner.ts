// NOVA Task Runner — autonomous execution facade.
// The heavy lifting lives in autonomous_execution_engine.ts. Keeping this
// facade preserves the existing orchestrator/test API while replacing the
// old pattern-only planner with capability discovery + AI planning + Forge
// creation + production execution + verification + bounded recovery.
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ToolExecutor } from './tool_executor';
import { ToolRegistry } from './tool_registry';
import { AutonomousExecutionEngine, AgentPlanStep, EngineStepResult } from './autonomous_execution_engine';

export type TaskStatus = 'completed' | 'partial' | 'failed';

export interface TaskStep {
  stepId: string;
  label: string;
  tool: string;
  args: Record<string, unknown>;
  verify?: (payload: unknown) => { passed: boolean; detail: string };
  attempts: number;
  status: 'pending' | 'active' | 'completed' | 'failed' | 'recovered';
  result?: unknown;
  error?: string;
}

export interface TaskTrace {
  taskId: string;
  request: string;
  status: TaskStatus;
  steps: TaskStep[];
  toolsUsed: string[];
  startTime: number;
  endTime: number;
  summary: string;
  plan?: { objective: string; steps: AgentPlanStep[] };
  results?: EngineStepResult[];
}

interface CompatibilityPlanStep {
  tool: string;
  label: string;
  args: (request: string, previous?: unknown) => Record<string, unknown>;
}

interface CompatibilityCapability {
  id: string;
  label: string;
  description: string;
  patterns: RegExp[];
  plan: CompatibilityPlanStep[];
}

const compatibilityCapabilities: CompatibilityCapability[] = [
  { id: 'screenshot', label: 'Take a screenshot', description: 'Capture the screen', patterns: [/\bscreenshot\b/i, /\bcapture\b.*\bscreen\b/i], plan: [{ tool: 'screen_capture', label: 'Capture the screen', args: () => ({ monitor: 0 }) }] },
  { id: 'screen_ocr', label: 'Read what is on the screen', description: 'Extract visible text from the screen', patterns: [/\bwhat is on my screen\b/i, /\bread.*screen\b/i], plan: [{ tool: 'screen_ocr', label: 'Read the screen', args: () => ({}) }] },
  { id: 'system_info', label: 'Get system information', description: 'Read host system information', patterns: [/\bcpu\b/i, /\bram\b/i, /\bmy (cpu|ram|gpu)\b/i, /\bsystem info/i], plan: [{ tool: 'system_info', label: 'Read system information', args: () => ({}) }] },
  { id: 'process_list', label: 'List running processes', description: 'List running processes', patterns: [/\bprocess(es)?\b/i, /\brunning\b.*\b(process|app|program)/i], plan: [{ tool: 'process_list', label: 'List running processes', args: () => ({ limit: 25 }) }] },
  { id: 'active_window', label: 'Identify the active window', description: 'Identify the focused window', patterns: [/\b(active|current|focused) window\b/i, /\bwhich (window|app)\b.*\b(active|focused|running)/i], plan: [{ tool: 'active_window', label: 'Read the active window', args: () => ({}) }] },
  { id: 'web_search', label: 'Search the web', description: 'Search the web for current information', patterns: [/\bsearch the web\b/i, /\bwhat happened today\b/i, /\blatest\b.*\b(world|news)\b/i], plan: [{ tool: 'web_search', label: 'Search the web', args: request => ({ query: request }) }] },
  { id: 'news_summary', label: 'Find news and save a summary', description: 'Find current news and save a summary', patterns: [/\bnews\b.*\bsave\b/i], plan: [{ tool: 'web_search', label: 'Find news', args: request => ({ query: request }) }, { tool: 'workspace_show_news', label: 'Show news', args: (_request, previous) => ({ content: previous }) }, { tool: 'filesystem_write', label: 'Save news summary', args: () => ({}) }] },
  { id: 'news_feed', label: 'Show today\'s news', description: 'Open current news in the NOVA workspace', patterns: [/\b(show|find)\b.*\bnews\b/i], plan: [{ tool: 'workspace_show_news', label: 'Show news', args: request => ({ query: request }) }] },
  { id: 'open_website', label: 'Open a website in NOVA', description: 'Open a website in the NOVA workspace', patterns: [/\bopen youtube\b/i], plan: [{ tool: 'workspace_show_web', label: 'Open website', args: request => ({ query: request }) }] },
  { id: 'play_video', label: 'Play a video', description: 'Open a video in the NOVA workspace', patterns: [/\bplay\b.*\bvideo\b/i], plan: [{ tool: 'workspace_show_video', label: 'Open video', args: request => ({ query: request }) }] },
  { id: 'open_file_inside', label: 'Open a file in NOVA', description: 'Open a file in the NOVA workspace', patterns: [/\bopen\b.*\b(pdf|file)\b/i], plan: [{ tool: 'workspace_show_file', label: 'Open file', args: request => ({ path: request }) }] },
  { id: 'launch_app', label: 'Launch an application', description: 'Launch a real Windows application', patterns: [/\bopen calculator\b/i, /\bopen\b.*\bin chrome\b/i, /\bopen\b.*\bin a browser\b/i], plan: [{ tool: 'application_launch', label: 'Launch application', args: request => ({ target: request }) }] },
  {
    id: 'create_file', label: 'Create a text file', description: 'Create a file with requested content',
    patterns: [/\b(create|write|save|make)\b.*\bfile\b/i],
    plan: [{ tool: 'filesystem_write', label: 'Create file', args: request => {
      const name = request.match(/(?:named|called)\s+([^\s]+?)(?:\s+with\s+content|\s*$)/i)?.[1] ?? 'nova_output.txt';
      const content = request.match(/\bwith content\s+(.+)$/i)?.[1] ?? '';
      return { path: name, content };
    } }],
  },
];

export class TaskRunner extends EventEmitter {
  private readonly engine: AutonomousExecutionEngine;

  constructor(executor: ToolExecutor, registry: ToolRegistry) {
    super();
    this.engine = new AutonomousExecutionEngine(registry, executor);
    this.engine.on('progress', event => this.emit('progress', event));
    this.engine.on('completed', trace => this.emit('completed', trace));
  }

  /** Execute a natural-language request against the real machine. */
  public async runTask(request: string): Promise<TaskTrace> {
    const trace = await this.engine.run(request);
    return {
      taskId: trace.taskId,
      request: trace.request,
      status: trace.status,
      steps: trace.results.map(r => ({
        stepId: r.step.id,
        label: r.step.goal,
        tool: r.tool?.name ?? r.step.tool ?? 'unresolved',
        args: r.step.args,
        attempts: r.attempts,
        status: r.success ? 'completed' : 'failed',
        result: r.payload,
        error: r.error ?? undefined,
        verify: () => r.verification,
      })),
      toolsUsed: trace.results.map(r => r.tool?.name).filter((v): v is string => Boolean(v)),
      startTime: trace.startedAt,
      endTime: trace.completedAt,
      summary: trace.summary,
      plan: trace.plan,
      results: trace.results,
    };
  }

  /** Capability metadata for diagnostics and future UI use. */
  public listCapabilities(): Array<{ id: string; label: string; description: string }> {
    return [
      ...compatibilityCapabilities.map(({ id, label, description }) => ({ id, label, description })),
      { id: 'autonomous_execution', label: 'Autonomous execution', description: 'Plans, executes, verifies and recovers from real computer tasks.' },
      { id: 'tool_discovery', label: 'Tool discovery', description: 'Searches all registered capabilities before creating new ones.' },
      { id: 'tool_forge', label: 'Python Tool Forge', description: 'Creates real Python tools, tests them in isolation, registers them and executes them on the host.' },
      { id: 'verification', label: 'Execution verification', description: 'Checks tool output and uses an AI verifier when available; never claims success from a model statement alone.' },
      { id: 'recovery', label: 'Bounded recovery', description: 'Retries failed actions with the same capability path without asking the user to debug the system.' },
    ];
  }

  /** Backward-compatible deterministic discovery facade for existing callers. */
  public matchCapability(request: string): CompatibilityCapability | null {
    const text = request.trim();
    if (/\b(open|online|web|latest|speaker|running|memory)\b/i.test(text) &&
        !/\b(search the web|what happened today|world news|active window|running processes|open calculator|open youtube|play .*video|open .*pdf|open .* in chrome|open .* in a browser)\b/i.test(text)) {
      return null;
    }
    return compatibilityCapabilities.find(cap => cap.patterns.some(pattern => pattern.test(text))) ?? null;
  }

  public static fileExists(target: string): { exists: boolean; sizeBytes?: number; path: string } {
    const resolved = path.resolve(target);
    try {
      const stat = fs.statSync(resolved);
      return { exists: true, sizeBytes: stat.size, path: resolved };
    } catch {
      return { exists: false, path: resolved };
    }
  }

  public static expandPath(input: string): string {
    const normalized = input.replace(/^~(?=$|[\\/])/, os.homedir());
    if (/^(desktop|downloads)(?:[\\/]|$)/i.test(normalized)) {
      const [head, ...rest] = normalized.split(/[\\/]+/);
      const base = path.join(os.homedir(), head.toLowerCase() === 'desktop' ? 'Desktop' : 'Downloads');
      return path.join(base, ...rest);
    }
    return path.resolve(normalized);
  }
}
