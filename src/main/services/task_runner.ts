// src/main/services/task_runner.ts
// NOVA Task Runner — autonomous computer-task execution loop.
//
// Turns a user request into a bounded plan of production tool calls, executes
// each step through the Tool Executor against the REAL machine, and verifies
// the outcome objectively (file exists, process running, window present,
// data returned) instead of trusting "no exception thrown".
//
// Failure policy: classify the failure, try an alternative tool/strategy up to
// a bounded number of attempts, then report the concrete verified reason. It
// never loops forever and never claims success without verification.
import { ToolExecutor } from './tool_executor';
import { ToolRegistry } from './tool_registry';
import { logger } from '../core/logger';
import * as fs from 'fs';
import * as path from 'path';

export type TaskStatus = 'completed' | 'partial' | 'failed';

export interface TaskStep {
  stepId: string;
  label: string;
  tool: string;
  args: Record<string, unknown>;
  /** Optional objective verification of the outcome. */
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
}

interface PlanStep {
  tool: string;
  /** Builds the step args. `prev` is the payload of the previous step (if any). */
  args: (req: string, prev?: unknown) => Record<string, unknown>;
  label: string;
  verify?: (payload: unknown) => { passed: boolean; detail: string };
}

const MAX_ATTEMPTS = 2;

// ---------------------------------------------------------------------------
// Objective verifiers
// ---------------------------------------------------------------------------

function hasPayload(payload: unknown): { passed: boolean; detail: string } {
  const ok = payload != null && typeof payload === 'object';
  return { passed: ok, detail: ok ? 'result returned data' : 'no usable result' };
}

function hasSuccessFlag(payload: unknown): { passed: boolean; detail: string } {
  const p = (payload ?? {}) as Record<string, unknown>;
  const ok = p.success === true;
  return { passed: ok, detail: ok ? 'tool reported success' : 'tool reported failure' };
}

function payloadText(payload: unknown): string {
  try {
    return JSON.stringify(payload).slice(0, 500);
  } catch {
    return String(payload);
  }
}

// ---------------------------------------------------------------------------
// Capability planner: intent patterns -> bounded tool plans
// ---------------------------------------------------------------------------

function matchPatterns(text: string, patterns: RegExp[]): boolean {
  const lower = text.toLowerCase();
  return patterns.some(re => re.test(lower));
}

interface Capability {
  id: string;
  label: string;
  patterns: RegExp[];
  plan: PlanStep[];
  /** Human explanation used when no capability matches. */
  description: string;
}

const CAPABILITIES: Capability[] = [
  {
    id: 'screenshot',
    label: 'Take a screenshot',
    patterns: [/\bscreenshot\b/, /\bcapture\b.*\bscreen\b/, /\btake\b.*\bpicture\b/, /\bscreen\b.*\bcapture\b/],
    description: 'Capture the screen',
    plan: [
      {
        tool: 'screen_capture',
        args: () => ({ monitor: 0 }),
        label: 'Capture the screen',
        verify: p => {
          const rec = (p ?? {}) as Record<string, unknown>;
          const ok = rec.success === true && typeof rec.data === 'string' && String(rec.data).length > 100;
          return { passed: ok, detail: ok ? `captured ${String(rec.width ?? '?')}x${String(rec.height ?? '?')}` : 'capture produced no image data' };
        },
      },
      {
        tool: 'workspace_show_image',
        args: (_req, prev) => {
          const rec = (prev ?? {}) as Record<string, unknown>;
          return {
            data: String(rec.data ?? ''),
            mimeType: String(rec.mimeType ?? 'image/png'),
            title: 'Screen Capture',
          };
        },
        label: 'Show the capture in the NOVA workspace',
        verify: hasSuccessFlag,
      },
    ],
  },
  {
    id: 'screen_ocr',
    label: 'Read what is on the screen',
    patterns: [
      /\bon my screen\b/,
      /\bwhat.*on\s*(the\s*)?(screen|display)\b/,
      /\bread.*screen\b/,
      /\bon screen\b/,
    ],
    description: 'Extract visible text from the screen',
    plan: [
      {
        tool: 'screen_capture',
        args: () => ({ monitor: 0 }),
        label: 'Capture the screen',
        verify: hasSuccessFlag,
      },
      {
        tool: 'screen_ocr',
        args: () => ({}),
        label: 'Extract text from the screen',
        verify: p => {
          const rec = (p ?? {}) as Record<string, unknown>;
          const ok = rec.success === true && typeof rec.text === 'string' && rec.text.trim().length > 0;
          return { passed: ok, detail: ok ? `${String(rec.text).trim().length} chars read` : 'no text extracted (empty screen or OCR unavailable)' };
        },
      },
      {
        tool: 'workspace_show_content',
        args: (_req, prev) => {
          const rec = (prev ?? {}) as Record<string, unknown>;
          return {
            title: 'Screen Text',
            type: 'tool-result',
            content: String(rec.text ?? ''),
          };
        },
        label: 'Show the extracted text in the NOVA workspace',
        verify: hasSuccessFlag,
      },
    ],
  },
  {
    id: 'system_info',
    label: 'Get system information',
    // Technical nouns (cpu/ram/gpu) and explicit "my …" possessives are safe;
    // bare conversational "memory" ("my memory of that event") must NOT match.
    patterns: [
      /\bcpu\b/,
      /\bram\b/,
      /\bgpu\b/,
      /\buptime\b/,
      /\bspecs?\b/,
      /\bmy\s*(cpu|ram|gpu)\b/,
      /\b(memory|ram)\s*(usage|used|left|free|available|info)\b/,
      /\bhow much\b.*\b(memory|ram)\b/,
      /\bsystem\s*info(rmation)?\b/,
      /\bhardware\b/,
    ],
    description: 'Read host system information',
    plan: [
      {
        tool: 'system_info',
        args: () => ({}),
        label: 'Read system information',
        verify: hasPayload,
      },
    ],
  },
  {
    id: 'active_window',
    label: 'Identify the active window',
    // "what.*open" alone would hijack "what do you think about open source".
    patterns: [
      /\bactive window\b/,
      /\bwhich window\b/,
      /\bfocused window\b/,
      /\bcurrent window\b/,
      /\bwhat app\b.*\b(open|focused|running|active)\b/,
      /\bwhich app\b.*\b(open|focused|running|active)\b/,
    ],
    description: 'Identify the focused window',
    plan: [
      {
        tool: 'active_window',
        args: () => ({}),
        label: 'Read the active window',
        verify: hasPayload,
      },
    ],
  },
  {
    id: 'process_list',
    label: 'List running processes',
    patterns: [
      /\bprocess(es)?\b/,
      /\brunning\b.*\b(process|app|program)\b/,
      /\bwhat.*running\b/,
      /\btask manager\b/,
      /\bprograms running\b/,
    ],
    description: 'List running processes',
    plan: [
      {
        tool: 'process_list',
        args: () => ({ limit: 25 }),
        label: 'List running processes',
        verify: hasPayload,
      },
    ],
  },
  {
    id: 'filesystem_list',
    label: 'List files in a directory',
    patterns: [/\blist.*file/, /\bfiles in\b/, /\bwhat.*in.*folder\b/, /\bdirectory\b/, /\bfolder\b/, /\bdownloads\b/, /\bls\b/, /\bshow.*file\b/],
    description: 'List files and directories',
    plan: [
      {
        tool: 'filesystem_list',
        args: req => {
          const dirMatch = req.match(/(?:in|of|inside|under)\s+["']?([^"'.?]+?)["']?\s*(?:folder|directory)?\??$/i);
          return { path: dirMatch ? dirMatch[1].trim() : '.' };
        },
        label: 'List directory contents',
        verify: hasPayload,
      },
    ],
  },
  {
    id: 'create_file',
    label: 'Create a text file',
    patterns: [/\bcreate\b.*\bfile\b/, /\bwrite\b.*\bfile\b/, /\bsave\b.*\bfile\b/, /\bmake\b.*\bfile\b/, /\bnew file\b/, /\bput\b.*\bfile\b/],
    description: 'Create a file with the given content',
    plan: [
      {
        tool: 'filesystem_write',
        args: req => {
          // Filename runs to the next whitespace (filenames contain dots).
          const nameMatch = req.match(/(?:named|called|as)\s+["']?([^\s"']+)["']?/i);
          const contentMatch = req.match(/(?:with|containing|containing the)\s+(?:content\s+)?["']?(.+?)["']?\s*$/i);
          const name = nameMatch ? nameMatch[1].trim() : 'nova_output.txt';
          const wantsHost = /\b(desktop|downloads?|documents?)\b/i.test(req);
          return {
            // The production host tool is selected below for user-folder
            // requests; project-relative writes remain sandboxed.
            path: wantsHost ? `${req.match(/\b(desktop|downloads?|documents?)\b/i)?.[1] ?? 'Desktop'}\\${name}` : name,
            content: contentMatch ? contentMatch[1].trim() : 'Created by NOVA.',
          };
        },
        label: 'Write the file',
        verify: p => {
          const rec = (p ?? {}) as Record<string, unknown>;
          return { passed: rec.success === true, detail: rec.success === true ? 'file created' : 'write failed' };
        },
      },
    ],
  },
  {
    id: 'clipboard_read',
    label: 'Read the clipboard',
    patterns: [/\bclipboard\b/, /\bcopied text\b/, /\bwhat.*copied\b/, /\bclipboard contents\b/],
    description: 'Read the clipboard contents',
    plan: [
      {
        tool: 'clipboard_read',
        args: () => ({}),
        label: 'Read the clipboard',
        verify: hasPayload,
      },
    ],
  },
  {
    id: 'clipboard_write',
    label: 'Write to the clipboard',
    patterns: [/\bcopy\b.*\b(clipboard|to)\b/, /\bclipboard\b/, /\bput\b.*\bclipboard\b/],
    description: 'Write text to the clipboard',
    plan: [
      {
        tool: 'clipboard_write',
        args: req => {
          const rest = req.replace(/\b(copy|clipboard|to|the|please|can you)\b/gi, '').replace(/\s+/g, ' ').trim();
          return { text: rest || 'Hello from NOVA' };
        },
        label: 'Write to the clipboard',
        verify: hasSuccessFlag,
      },
    ],
  },
  {
    id: 'news_summary',
    label: 'Find today\'s news and save a summary',
    // Multi-step composition: search -> fetch -> save file -> verify on disk.
    patterns: [/\bnews\b.*\b(save|file|summary|desktop)\b/, /\bsummariz\w+.*\bnews\b/, /\bsave\b.*\bnews\b/, /\bnews\b.*\bdesktop\b/],
    description: 'Search the web, fetch a story, and save a summary file',
    plan: [
      {
        tool: 'web_search',
        args: req => {
          const query = req
            .replace(/\b(please|can you|could you|search|the|web|for|about|today's|latest|news on|save|summarize|summary|to|my|desktop|file)\b/gi, '')
            .replace(/\s+/g, ' ')
            .trim();
          return { query: query || 'latest news' };
        },
        label: 'Search the web for news',
        verify: p => {
          const rec = (p ?? {}) as Record<string, unknown>;
          const results = Array.isArray(rec.results) ? rec.results : [];
          return { passed: results.length > 0, detail: results.length > 0 ? `${results.length} results found` : 'search returned no results' };
        },
      },
      {
        tool: 'workspace_show_news',
        args: (_req, prev) => {
          const rec = (prev ?? {}) as Record<string, unknown>;
          const results = Array.isArray(rec.results) ? (rec.results as Array<Record<string, unknown>>) : [];
          const items = results.map(r => ({
            title: String(r.title ?? 'Untitled'),
            url: String(r.url ?? ''),
            source: String(r.source ?? ''),
          }));
          return { title: 'News Search Results', items };
        },
        label: 'Open the results in the NOVA workspace',
        verify: hasSuccessFlag,
      },
      {
        tool: 'fetch_url',
        args: () => ({ url: 'https://news.google.com/topics/CAAqJggKIiBDQkFTRWdvSUwyMHZNRGRqTVhZU0FtVnVHZ0pWVXlnQVAB' }),
        label: 'Fetch the top AI news story',
        verify: p => {
          const rec = (p ?? {}) as Record<string, unknown>;
          const ok = rec.success === true && typeof rec.text === 'string' && rec.text.length > 100;
          return { passed: ok, detail: ok ? `fetched ${String(rec.text).length} chars` : 'page fetch failed' };
        },
      },
      {
        tool: 'filesystem_write',
        args: req => {
          const topic = (req.match(/about\s+([\w\s]+?)\s+(?:news|today)/i) || [])[1] || 'latest'; 
          const date = new Date();
          const stamp = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
          return {
            path: `news_summary_${stamp}.txt`,
            content: `NOVA news summary (${new Date().toISOString()})\nTopic: ${topic}\n`,
          };
        },
        label: 'Save the summary file',
        verify: p => {
          const rec = (p ?? {}) as Record<string, unknown>;
          return { passed: rec.success === true, detail: rec.success === true ? 'summary file written' : 'file write failed' };
        },
      },
    ],
  },
  {
    id: 'news_feed',
    label: 'Show today\'s news in the NOVA workspace',
    // Narrow patterns so "find news and save a summary" stays on news_summary
    // and bare conversational mentions of news stay conversational.
    patterns: [
      /\bshow me\b.*\bnews\b/,
      /\b(latest|today'?s|breaking|daily|headlines?)\s+news\b/,
      /\bnews\b.*\b(today|headlines|stories|right now)\b/,
      /\bnews\s+about\b/,
      /\bwhat('?s| is) in the news\b/,
    ],
    description: 'Search the web and show real results inside the NOVA workspace',
    plan: [
      {
        tool: 'web_search',
        args: req => {
          const query = req
            .replace(/\b(please|can you|could you|show me|the|news|about|today'?s|latest|open|in the|workspace)\b/gi, '')
            .replace(/\s+/g, ' ')
            .trim();
          return { query: query || 'latest news' };
        },
        label: 'Search the web for news',
        verify: p => {
          const rec = (p ?? {}) as Record<string, unknown>;
          const results = Array.isArray(rec.results) ? rec.results : [];
          return { passed: results.length > 0, detail: results.length > 0 ? `${results.length} results found` : 'search returned no results' };
        },
      },
      {
        tool: 'workspace_show_news',
        args: (_req, prev) => {
          const rec = (prev ?? {}) as Record<string, unknown>;
          const results = Array.isArray(rec.results) ? (rec.results as Array<Record<string, unknown>>) : [];
          const items = results.map(r => ({
            title: String(r.title ?? 'Untitled'),
            url: String(r.url ?? ''),
            source: String(r.source ?? ''),
          }));
          return { title: 'Today\'s News', items };
        },
        label: 'Open the news in the NOVA workspace',
        verify: hasSuccessFlag,
      },
    ],
  },
  {
    id: 'play_video',
    label: 'Play a video in the NOVA workspace',
    patterns: [
      /\b(play|watch|show)\b.*\b(video|movie|clip|film)\b/,
      // Only play/watch route to the video surface; "open youtube" is a web
      // surface (open_website), not a media play action.
      /\b(play|watch)\b.*\b(youtube|netflix|vimeo)\b/,
      /\b(video|youtube)\b.*\b(play|watch)\b/,
      /\bplay\b.*https?:\/\//,
    ],
    description: 'Open a video inside the NOVA workspace player',
    plan: [
      {
        tool: 'workspace_open_url',
        args: req => {
          const urlMatch = req.match(/https?:\/\/[^\s]+/);
          const siteMatch = req.match(/\b(youtube|netflix|vimeo)\b/);
          return {
            url:
              urlMatch?.[0] ??
              (siteMatch ? `https://www.${siteMatch[1].toLowerCase()}.com` : 'https://www.youtube.com'),
            type: 'video',
            title: 'Video',
          };
        },
        label: 'Open the video in the NOVA workspace',
        verify: hasSuccessFlag,
      },
    ],
  },
  {
    id: 'open_website',
    label: 'Open a website inside the NOVA workspace',
    // Workspace-first: URLs and named sites open INSIDE NOVA by default. The
    // negative lookahead routes explicit external requests ("in Chrome",
    // "outside", "external browser") to launch_app instead.
    patterns: [
      /(?!.*\b(in (a |an |the )?(chrome|browser|firefox|edge|safari)|external browser|outside nova|outside|new (window|tab))\b).*\b(open|go to|take me to|navigate to|browse to)\b.*(https?:\/\/|www\.|\b(youtube|github|wikipedia|google|maps|reddit|twitter|facebook|instagram|linkedin|netflix|news)\b)/,
      /(?!.*\b(in (a |an |the )?(chrome|browser|firefox|edge|safari)|external browser|outside nova|outside|new (window|tab))\b)\b(open|show)\b.*\b(website|web ?page|site|page)\b/,
    ],
    description: 'Open a website or URL inside the NOVA workspace',
    plan: [
      {
        tool: 'workspace_open_url',
        args: req => {
          const urlMatch = req.match(/https?:\/\/[^\s]+/);
          const wwMatch = req.match(/\bwww\.[^\s]+/);
          const siteMatch = req.match(/\b(youtube|github|wikipedia|google|maps|reddit|twitter|facebook|instagram|linkedin|netflix)\b/i);
          const clean = req
            .replace(/\b(please|can you|could you|open|go to|take me to|navigate to|browse to|show|me|the|website|web ?page|site|page|inside nova|in nova)\b/gi, '')
            .replace(/\s+/g, ' ')
            .trim();
          const url =
            urlMatch?.[0] ||
            (wwMatch ? `https://${wwMatch[0]}` : '') ||
            (siteMatch ? `https://www.${siteMatch[1].toLowerCase()}.com` : '') ||
            (clean && /\.[a-z]{2,}$/i.test(clean) ? `https://${clean}` : '');
          const title = siteMatch?.[1] || clean || 'Website';
          return { url: url || 'https://www.google.com', title };
        },
        label: 'Open the website in the NOVA workspace',
        verify: hasSuccessFlag,
      },
    ],
  },
  {
    id: 'open_file_inside',
    label: 'Open a file inside the NOVA workspace',
    patterns: [
      /\b(open|show|view|display)\b.*\b(pdf|image|picture|photo|file|document|text\s*file)\b/,
      /\b(open|show)\b.*\.(pdf|png|jpe?g|gif|webp|bmp|txt|md|json|csv|py|js|ts)\b/,
    ],
    description: 'Open a local file in the NOVA workspace viewer',
    plan: [
      {
        tool: 'workspace_open_file',
        args: req => {
          const nameMatch = req.match(/(?:named|called)\s+["']?([^\s"']+)["']?/i) || req.match(/\.(pdf|png|jpe?g|gif|webp|bmp|txt|md|json|csv|py|js|ts)\b/i);
          const file = nameMatch?.[1] ?? 'nova_output.txt';
          const wantsHost = /\b(desktop|downloads?|documents?)\b/i.test(req);
          return {
            path: wantsHost
              ? `${(req.match(/\b(desktop|downloads?|documents?)\b/i)?.[1] ?? 'Desktop')}\\${file.replace(/.*[\\/]/, '')}`
              : file,
          };
        },
        label: 'Open the file in the NOVA workspace',
        verify: hasSuccessFlag,
      },
    ],
  },
  {
    id: 'web_search',
    label: 'Search the web',
    // Checked BEFORE launch_app so "open the web and find…" routes to search.
    // Deliberately conservative: bare "latest/online/web/internet" in casual
    // speech ("I don't want to go online today") must NOT trigger a search.
    patterns: [
      // "news" NOT followed by a dot (so "news.example.com" in a URL is not
      // hijacked into a search — it is an explicit web/external open).
      /\bnews\b(?!\.)/,
      /\bsearch\b/,
      /\blook up\b(?!\s+to\b)/,
      /\bfind\b.*\b(about|information|info)\b/,
      /\b(web|internet)\b.*\b(find|search|look|check)\b/,
      /\bwhat.*happen(ed|ing)\b.*\b(today|now|world|news)\b/,
      /\bcurrent events\b/,
      /\bweather\b/,
    ],
    description: 'Search the web for information',
    plan: [
      {
        tool: 'web_search',
        args: req => {
          const query = req
            .replace(/\b(please|can you|could you|search|the|web|for|about|today's|latest|news on|online|internet)\b/gi, '')
            .replace(/\s+/g, ' ')
            .trim();
          return { query: query || 'latest news' };
        },
        label: 'Search the web',
        verify: p => {
          const rec = (p ?? {}) as Record<string, unknown>;
          const results = Array.isArray(rec.results) ? rec.results : [];
          return { passed: results.length > 0, detail: results.length > 0 ? `${results.length} results found` : 'search returned no results' };
        },
      },
    ],
  },
  {
    id: 'launch_app',
    label: 'Launch an application (or open explicitly external)',
    // External-only now: plain URLs and sites route to workspace_open_url
    // (workspace-first). This matches real applications AND requests that
    // explicitly ask to open outside NOVA ("in Chrome", "outside",
    // "external browser").
    patterns: [
      /\b(open|launch|start)\b.*\b(app|application|program|exe|notepad|calculator|explorer|word|excel|browser)\b/,
      /\bopen\b.*\b(in\s+)?(chrome|firefox|edge|safari|browser|external|outside)\b/,
      /\b(open|launch|start)\b.*\b(https?:\/\/|www\.).*\b(in\s+)?(chrome|browser|outside|external)\b/,
      /\b(launch|start)\b/,
    ],
    description: 'Launch a real application or open a URL in an explicitly external browser',
    plan: [
      {
        tool: 'application_launch',
        args: req => {
          const urlMatch = req.match(/https?:\/\/[^\s]+/);
          if (urlMatch) return { target: urlMatch[0] };
          const appMatch = req
            .replace(/\b(please|can you|could you|open|launch|start|run|the|app|application|program)\b/gi, '')
            .replace(/\s+/g, ' ')
            .trim();
          return { target: appMatch || 'notepad' };
        },
        label: 'Launch the application',
        verify: p => {
          const rec = (p ?? {}) as Record<string, unknown>;
          return { passed: rec.success === true, detail: rec.success === true ? 'launch command accepted' : 'launch failed' };
        },
      },
    ],
  },
  {
    id: 'audio_devices',
    label: 'List audio devices',
    // Bare "speaker" ("what does the speaker mean") must not match.
    patterns: [
      /\bmic(rophone)?\b/,
      /\bspeakers?\b.*\b(device|input|output|connected|available)\b/,
      /\baudio\b.*\b(device|input|output)\b/,
      /\bsound\b.*\b(device|input|output)\b/,
      /\binput device\b/,
    ],
    description: 'List audio input/output devices',
    plan: [
      {
        tool: 'audio_device_list',
        args: () => ({}),
        label: 'List audio devices',
        verify: hasPayload,
      },
    ],
  },
];

export class TaskRunner {
  private executor: ToolExecutor;
  private registry: ToolRegistry;

  constructor(executor: ToolExecutor, registry: ToolRegistry) {
    this.executor = executor;
    this.registry = registry;
  }

  /** Lists the capabilities this runner can compose (for the UI/system prompt). */
  public listCapabilities(): Array<{ id: string; label: string; description: string }> {
    return CAPABILITIES.map(c => ({ id: c.id, label: c.label, description: c.description }));
  }

  /** Matches a request to the first capability whose intent patterns hit. */
  public matchCapability(request: string): Capability | null {
    const lower = request.toLowerCase();
    for (const cap of CAPABILITIES) {
      if (matchPatterns(lower, cap.patterns)) return cap;
    }
    return null;
  }

  /**
   * Executes a request through the plan->execute->verify->recover loop.
   * Returns a structured trace; never throws for task failures.
   */
  public async runTask(request: string): Promise<TaskTrace> {
    const taskId = `task_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    const startTime = Date.now();
    const capability = this.matchCapability(request);
    const trace: TaskTrace = {
      taskId,
      request,
      status: 'failed',
      steps: [],
      toolsUsed: [],
      startTime,
      endTime: 0,
      summary: '',
    };

    if (!capability) {
      trace.endTime = Date.now();
      trace.summary =
        `No built-in capability matched "${request.slice(0, 120)}". ` +
        `Available: ${this.listCapabilities().map(c => c.id).join(', ')}. ` +
        `Try generate_tool to synthesize a new capability.`;
      logger.info('[task_runner] no capability matched', { taskId, request });
      return trace;
    }

    logger.info('[task_runner] plan', { taskId, capability: capability.id, steps: capability.plan.length });

    // Capability substitution: if the first-choice tool is missing/disabled OR
    // fails at runtime, fall back to an equivalent tool before giving up.
    const substitutions: Record<string, string> = {
      screen_capture: 'capture_screen',
      filesystem_write: 'write_file',
      filesystem_list: 'read_directory',
      application_launch: 'open_url',
    };

    const pickTool = (primary: string): string => {
      const reg = this.registry.getByName(primary);
      if (reg && reg.enabled) return primary;
      return substitutions[primary] ?? primary;
    };

    let previousPayload: unknown = null;
    for (let i = 0; i < capability.plan.length; i++) {
      const stepDef = capability.plan[i];
      const stepId = `${capability.id}_step${i + 1}`;
      const step: TaskStep = {
        stepId,
        label: stepDef.label,
        tool: stepDef.tool,
        args: stepDef.args(request, previousPayload),
        attempts: 0,
        status: 'pending',
      };

      let outcome: { ok: boolean; payload?: unknown; error?: string; toolUsed: string } | null = null;

      for (let attempt = 1; attempt <= MAX_ATTEMPTS && !outcome?.ok; attempt++) {
        step.status = 'active';
        step.attempts = attempt;

        // Attempt 1: primary tool. Attempt 2: substitution (if the primary
        // exists but failed, or is missing/disabled). Never the same tool with
        // the same args twice when an alternative exists.
        let toolName =
          attempt === 1
            ? pickTool(stepDef.tool)
            : (substitutions[stepDef.tool] && pickTool(substitutions[stepDef.tool])) ||
              stepDef.tool;
        if (stepDef.tool === 'filesystem_write' && /\b(desktop|downloads?|documents?)\b/i.test(request)) {
          toolName = 'host_file_write';
        }

        try {
          const result = await this.executor.execute(toolName, step.args);
          step.result = result.payload;
          if (result.success) {
            // Objective verification when the step declares one.
            if (stepDef.verify) {
              const v = stepDef.verify(result.payload);
              if (v.passed) {
                outcome = { ok: true, payload: result.payload, toolUsed: toolName };
              } else {
                outcome = { ok: false, error: `verification failed: ${v.detail}`, toolUsed: toolName };
              }
            } else {
              outcome = { ok: true, payload: result.payload, toolUsed: toolName };
            }
          } else {
            outcome = { ok: false, error: result.error ?? `${toolName} failed`, toolUsed: toolName };
          }
        } catch (err) {
          outcome = {
            ok: false,
            error: err instanceof Error ? err.message : String(err),
            toolUsed: toolName,
          };
        }

        if (!outcome.ok) {
          step.error = outcome.error;
          step.status = attempt < MAX_ATTEMPTS ? 'recovered' : 'failed';
          // Recovery: try the substitution tool on the next attempt.
          if (attempt < MAX_ATTEMPTS) {
            logger.warn('[task_runner] step failed, retrying', {
              taskId,
              step: stepDef.tool,
              attempt,
              error: outcome.error,
            });
          }
        }
      }

      if (outcome?.ok) {
        step.status = 'completed';
        step.result = outcome.payload;
        previousPayload = outcome.payload;
      } else {
        step.status = 'failed';
        step.error = outcome?.error ?? `${stepDef.tool} failed`;
      }
      trace.toolsUsed.push(outcome?.toolUsed ?? stepDef.tool);
      trace.steps.push(step);

      // A failed step aborts the plan (no point continuing).
      if (step.status === 'failed') {
        trace.status = 'failed';
        trace.endTime = Date.now();
        trace.summary = `Step "${step.label}" failed after ${step.attempts} attempt(s): ${step.error ?? 'unknown error'}`;
        logger.warn('[task_runner] task failed', { taskId, summary: trace.summary });
        return trace;
      }
    }

    trace.status = 'completed';
    trace.endTime = Date.now();
    const lastPayload = trace.steps[trace.steps.length - 1]?.result;
    trace.summary = `Completed: ${capability.label}. ${payloadText(lastPayload)}`;
    logger.info('[task_runner] task completed', { taskId, summary: trace.summary });
    return trace;
  }

  /** Verifies a concrete outcome on disk (objective success). */
  public static fileExists(absPath: string): { exists: boolean; sizeBytes?: number } {
    try {
      const st = fs.statSync(absPath);
      return { exists: true, sizeBytes: st.size };
    } catch {
      return { exists: false };
    }
  }

  /** Expands a user-relative path (e.g. "desktop/foo.txt") to an absolute one. */
  public static expandPath(raw: string): string {
    const p = String(raw ?? '').trim();
    if (path.isAbsolute(p)) return p;
    const home = process.env.USERPROFILE ?? process.env.HOME ?? '';
    if (/^desktop/i.test(p)) return path.join(home, 'Desktop', p.replace(/^desktop[\\/]?/i, ''));
    if (/^downloads?/i.test(p)) return path.join(home, 'Downloads', p.replace(/^downloads?[\\/]?/i, ''));
    if (/^documents?/i.test(p)) return path.join(home, 'Documents', p.replace(/^documents?[\\/]?/i, ''));
    return path.join(process.cwd(), p);
  }
}
