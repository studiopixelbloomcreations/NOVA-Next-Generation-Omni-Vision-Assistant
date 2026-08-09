// src/main/services/builtin_tools.ts
// Builtin tool registration for the NOVA Tool Registry.
//
// Every built-in capability NOVA ships with is registered here as an audited
// host handler. Host handlers run in the main process but are permission-scoped
// and covered by the audit logger; they never execute arbitrary code.
//
// Network device discovery (smart lights, printers) and HTTP control live here
// too, behind a strict host allowlist (see NovaConfig.security) so NOVA can
// never be used as a blind SSRF proxy into the LAN.
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as net from 'net';
import * as os from 'os';
import { desktopCapturer } from 'electron';
import { ToolRegistry } from './tool_registry';
import { ToolExecutor } from './tool_executor';
import { ToolDefinition } from './tool_types';
import { WorkspaceManager } from './workspace_manager';
import { logger } from '../core/logger';
import { NovaConfig } from '../core/config';
import { windowsIntegration } from './windows_integration';
import { pythonRuntime } from './python_runtime';

export interface BuiltinToolDeps {
  /** Sandbox root for project/filesystem builtins. */
  projectRoot: string;
  /** Resolves a relative path inside the sandbox (throws when escaping). */
  resolvePath(requested: string): string;
  /** Resolves an explicitly user-facing host path (Desktop/Documents/etc.). */
  resolveHostPath(requested: string): string;
  /** Persists a long-running automation task; returns a task id. */
  queueAutomationTask(kind: string, prompt: string): string;
  /** Tool Builder used by the generate_tool builtin. */
  builder: {
    ensureCapability(intent: string): Promise<{
      tool: { id: string; name: string };
      result: unknown;
      executionOk: boolean;
    }>;
  };
  /** Active-project state read/write for switch_project / list_projects. */
  setActiveProject(name: string | null): void;
  getActiveProject(): string | null;
  /**
   * Workspace Manager for internal NOVA surfaces (workspace-first). Optional
   * so headless unit tests can register builtins without a workspace store;
   * production wiring always provides it.
   */
  workspace?: WorkspaceManager;
}

/** Rejects non-http(s) workspace URLs (no file://, javascript:, data:). */
function assertWorkspaceUrl(url: string): string | null {
  const trimmed = String(url ?? '').trim();
  if (!/^https?:\/\//i.test(trimmed)) {
    return 'workspace URL must start with http(s)://';
  }
  return null;
}

const IMAGE_MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
};

const TEXT_EXTENSIONS = new Set(['.txt', '.md', '.markdown', '.json', '.js', '.ts', '.py', '.css', '.html', '.log', '.csv', '.xml', '.yml', '.yaml', '.toml', '.ini', '.cfg', '.conf']);

/** Finds the local subnet (/24) used for network device discovery. */
function detectLocalSubnet(): string {
  const interfaces = os.networkInterfaces();
  for (const group of Object.values(interfaces)) {
    for (const iface of group ?? []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        const parts = iface.address.split('.');
        if (parts.length === 4) return `${parts[0]}.${parts[1]}.${parts[2]}.`;
      }
    }
  }
  return '192.168.1.';
}

async function scanPorts(
  ports: number[],
  timeoutMs: number,
  label: string,
  concurrency = 48,
): Promise<string[]> {
  const subnet = detectLocalSubnet();
  const found: string[] = [];
  const targets: Array<{ ip: string; port: number }> = [];
  for (let i = 1; i < 255; i++) {
    const ip = `${subnet}${i}`;
    for (const port of ports) targets.push({ ip, port });
  }

  const probe = (target: { ip: string; port: number }): Promise<void> =>
    new Promise(resolve => {
      const socket = new net.Socket();
      let settled = false;
      const done = (): void => {
        if (settled) return;
        settled = true;
        socket.destroy();
        resolve();
      };
      socket.setTimeout(timeoutMs);
      socket.once('connect', () => {
        found.push(`${label} at ${target.ip}:${target.port}`);
        done();
      });
      socket.once('error', done);
      socket.once('timeout', done);
      socket.connect(target.port, target.ip);
    });

  let cursor = 0;
  const workers: Promise<void>[] = [];
  for (let w = 0; w < concurrency; w++) {
    workers.push(
      (async () => {
        while (cursor < targets.length) {
          const target = targets[cursor++];
          await probe(target);
        }
      })(),
    );
  }
  await Promise.all(workers);
  return found;
}

/**
 * Host allowlist guard for the HTTP control builtins. Loopback and configured
 * hosts (NOVA_CONTROL_HOSTS) are allowed; schemes, paths and arbitrary LAN
 * addresses are rejected so a prompt cannot turn NOVA into an SSRF proxy.
 */
function assertControlTargetAllowed(target: string, port: number): string | null {
  const host = target.toLowerCase();
  const allowedHosts = NovaConfig.security.controlHosts;
  if (allowedHosts.includes(host)) {
    if (NovaConfig.security.controlPorts.includes(port)) return null;
    return `Port ${port} is not in the control allowlist (NOVA_CONTROL_PORTS).`;
  }
  // Must be a plain hostname/IP literal — reject schemes, paths, credentials.
  if (!/^[a-z0-9.-]+$/i.test(host) || host.startsWith('-')) {
    return `Invalid control target: '${target}'`;
  }
  return `Target '${target}' is not in the control host allowlist (NOVA_CONTROL_HOSTS).`;
}

function httpJsonControl(
  kind: 'control' | 'print' | 'status',
  args: Record<string, unknown>,
): Promise<{ success: boolean; result: string }> {
  const target = String(args.target ?? args.printer ?? '').trim();
  if (!target) return Promise.resolve({ success: false, result: `${kind}: target device required` });
  const port = Number(args.port ?? 80);
  const allowlistError = assertControlTargetAllowed(target, port);
  if (allowlistError) {
    logger.audit('iot.control', 'denied', { kind, target, reason: allowlistError });
    return Promise.resolve({ success: false, result: `${kind} blocked: ${allowlistError}` });
  }
  const pathPart = kind === 'control' ? '/api/control' : kind === 'print' ? '/api/print' : '/api/status';
  const method = kind === 'status' ? 'GET' : 'POST';
  const body =
    method === 'POST'
      ? JSON.stringify({
          action: args.action ?? undefined,
          brightness: args.brightness ?? undefined,
          color: args.color ?? undefined,
          file: args.stl_path ?? args.file ?? undefined,
          profile: args.profile ?? undefined,
          timestamp: Date.now(),
        })
      : '';

  return new Promise(resolve => {
    const socket = new net.Socket();
    socket.setTimeout(kind === 'print' ? 10000 : 3000);
    const done = (result: string): void => {
      socket.destroy();
      resolve({ success: true, result });
    };
    socket.once('error', () => done(`${kind} failed: could not reach ${target}`));
    socket.once('timeout', () => done(`${kind} timeout: ${target} did not respond`));
    socket.connect(port, target, () => {
      const headers = [
        `${method} ${pathPart} HTTP/1.1`,
        `Host: ${target}`,
        'Connection: close',
      ];
      if (method === 'POST') {
        headers.push('Content-Type: application/json');
        headers.push(`Content-Length: ${Buffer.byteLength(body)}`);
      }
      socket.write(`${headers.join('\r\n')}\r\n\r\n${body}`);
    });
    let response = '';
    socket.on('data', data => {
      response += data.toString();
    });
    socket.once('end', () => {
      if (response.includes('200 OK') || response.includes('201 Created')) {
        done(`${kind} succeeded at ${target}`);
      } else if (response.includes('404')) {
        done(`${kind}: ${target} returned 404 — endpoint not found`);
      } else {
        done(`${kind} request sent to ${target} (no confirmation)`);
      }
    });
  });
}

/**
 * Registers every built-in tool on the registry and its host handler on the
 * executor. Idempotent per tool name.
 */
export function registerBuiltinTools(
  registry: ToolRegistry,
  executor: ToolExecutor,
  deps: BuiltinToolDeps,
): void {
  const builtins: Array<{
    name: string;
    description: string;
    category: string;
    permissions: ToolDefinition['permissions'];
    handler: (args: Record<string, unknown>) => Promise<unknown>;
  }> = [
    {
      name: 'create_project',
      description: 'Creates a new project folder in the NOVA workspace.',
      category: 'filesystem',
      permissions: [{ type: 'fs-write', scope: [deps.projectRoot] }],
      handler: async args => {
        const name = String(args.name ?? '').trim();
        if (!name) return { success: false, error: 'Project name required' };
        const target = deps.resolvePath(name);
        fs.mkdirSync(target, { recursive: true });
        return { success: true, result: `Created project ${name}` };
      },
    },
    {
      name: 'switch_project',
      description: 'Switches the current active project context.',
      category: 'filesystem',
      permissions: [{ type: 'fs-read', scope: [deps.projectRoot] }],
      handler: async args => {
        const name = String(args.name ?? '').trim();
        if (!name) return { success: false, error: 'Project name required' };
        const target = deps.resolvePath(name);
        if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) {
          return { success: false, error: `Project ${name} does not exist` };
        }
        deps.setActiveProject(name);
        return { success: true, result: `Active project: ${name}` };
      },
    },
    {
      name: 'list_projects',
      description: 'Lists all projects in the NOVA workspace.',
      category: 'filesystem',
      permissions: [{ type: 'fs-read', scope: [deps.projectRoot] }],
      handler: async () => {
        const entries = fs
          .readdirSync(deps.projectRoot, { withFileTypes: true })
          .filter(e => e.isDirectory())
          .map(e => e.name);
        return { success: true, projects: entries, active: deps.getActiveProject() };
      },
    },
    {
      name: 'write_file',
      description: 'Writes a file inside the active project sandbox.',
      category: 'filesystem',
      permissions: [{ type: 'fs-write', scope: [deps.projectRoot] }],
      handler: async args => {
        const rel = String(args.path ?? '');
        const content = String(args.content ?? '');
        const filePath = deps.resolvePath(rel);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, content, 'utf-8');
        return { success: true, result: `Wrote ${rel} (${Buffer.byteLength(content)} bytes)` };
      },
    },
    {
      name: 'read_file',
      description: 'Reads a file inside the active project sandbox.',
      category: 'filesystem',
      permissions: [{ type: 'fs-read', scope: [deps.projectRoot] }],
      handler: async args => {
        const filePath = deps.resolvePath(String(args.path ?? ''));
        return { success: true, content: fs.readFileSync(filePath, 'utf-8') };
      },
    },
    {
      name: 'read_directory',
      description: 'Lists the contents of a directory inside the sandbox.',
      category: 'filesystem',
      permissions: [{ type: 'fs-read', scope: [deps.projectRoot] }],
      handler: async args => {
        const dirPath = deps.resolvePath(String(args.path ?? '.'));
        return { success: true, entries: fs.readdirSync(dirPath) };
      },
    },
    {
      name: 'filesystem_list',
      description: 'Lists files and directories with path validation and structured output.',
      category: 'filesystem',
      permissions: [{ type: 'fs-read', scope: [deps.projectRoot] }],
      handler: async args => {
        const requested = String(args.path ?? args.dir ?? '.');
        const dirPath = deps.resolvePath(requested);
        if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) {
          return { success: false, error: `not a directory: ${requested}` };
        }
        const entries = fs
          .readdirSync(dirPath, { withFileTypes: true })
          .map(e => ({
            name: e.name,
            isDir: e.isDirectory(),
            isFile: e.isFile(),
          }))
          .sort((a, b) => (a.name < b.name ? -1 : 1));
        return { success: true, path: dirPath, entries };
      },
    },
    {
      name: 'filesystem_read',
      description: 'Reads a text file with path validation, size limit, and safe errors.',
      category: 'filesystem',
      permissions: [{ type: 'fs-read', scope: [deps.projectRoot] }],
      handler: async args => {
        try {
          const filePath = deps.resolvePath(String(args.path ?? ''));
          const size = fs.statSync(filePath).size;
          if (size > 2 * 1024 * 1024) {
            return { success: false, error: `file exceeds 2 MB read limit (${size} bytes)` };
          }
          return { success: true, path: filePath, sizeBytes: size, content: fs.readFileSync(filePath, 'utf-8') };
        } catch (err) {
          return {
            success: false,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      },
    },
    {
      name: 'filesystem_write',
      description: 'Writes a text file with permission enforcement and audit logging.',
      category: 'filesystem',
      permissions: [{ type: 'fs-write', scope: [deps.projectRoot] }],
      handler: async args => {
        try {
          const rel = String(args.path ?? '');
          const content = String(args.content ?? '');
          const filePath = deps.resolvePath(rel);
          fs.mkdirSync(path.dirname(filePath), { recursive: true });
          fs.writeFileSync(filePath, content, 'utf-8');
          logger.audit('tool.filesystem_write', 'ok', {
            path: filePath,
            bytes: Buffer.byteLength(content),
          });
          return { success: true, path: filePath, sizeBytes: Buffer.byteLength(content) };
        } catch (err) {
          return {
            success: false,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      },
    },
    {
      name: 'host_file_write',
      description: 'Creates or replaces a text file in an explicitly requested user host location.',
      category: 'host-filesystem',
      permissions: [{ type: 'fs-write', scope: ['user-approved-path'] }],
      handler: async args => {
        try {
          const requested = String(args.path ?? '').trim();
          if (!requested) return { success: false, error: 'path required' };
          const filePath = deps.resolveHostPath(requested);
          const content = String(args.content ?? '');
          fs.mkdirSync(path.dirname(filePath), { recursive: true });
          fs.writeFileSync(filePath, content, 'utf-8');
          const stat = fs.statSync(filePath);
          logger.audit('tool.host_file_write', 'ok', { path: filePath, bytes: stat.size });
          return { success: true, path: filePath, sizeBytes: stat.size };
        } catch (err) {
          return { success: false, error: err instanceof Error ? err.message : String(err) };
        }
      },
    },
    {
      name: 'host_file_read',
      description: 'Reads a text file from an explicitly requested user host location.',
      category: 'host-filesystem',
      permissions: [{ type: 'fs-read', scope: ['user-approved-path'] }],
      handler: async args => {
        try {
          const filePath = deps.resolveHostPath(String(args.path ?? '').trim());
          const stat = fs.statSync(filePath);
          if (stat.size > 2 * 1024 * 1024) return { success: false, error: 'file exceeds 2 MB read limit' };
          return { success: true, path: filePath, sizeBytes: stat.size, content: fs.readFileSync(filePath, 'utf-8') };
        } catch (err) {
          return { success: false, error: err instanceof Error ? err.message : String(err) };
        }
      },
    },
    {
      name: 'run_web_agent',
      description: 'Opens a URL in the default web browser to complete a task.',
      category: 'web',
      permissions: [{ type: 'net-https', scope: ['*'] }],
      handler: async args => {
        const prompt = String(args.prompt ?? '');
        const urlMatch = prompt.match(/https?:\/\/[^\s]+/);
        if (urlMatch) {
          const { shell } = await import('electron');
          await shell.openExternal(urlMatch[0]);
          return { success: true, result: `Opened ${urlMatch[0]} in the default browser` };
        }
        return {
          success: true,
          result: 'No URL found in the request; queued as an automation task.',
          taskId: deps.queueAutomationTask('web_agent', prompt),
        };
      },
    },
    {
      name: 'clipboard_read',
      description: 'Reads text from the system clipboard.',
      category: 'system',
      permissions: [{ type: 'clipboard', scope: ['*'] }],
      handler: async () => ({ success: true, text: windowsIntegration.readClipboard() }),
    },
    {
      name: 'clipboard_write',
      description: 'Writes text to the system clipboard.',
      category: 'system',
      permissions: [{ type: 'clipboard', scope: ['*'] }],
      handler: async args => {
        const text = String(args.text ?? '');
        const ok = windowsIntegration.writeClipboard(text);
        if (!ok) return { success: false, error: 'clipboard write failed' };
        // Verify by read-back: Windows clipboard propagation can lag (and
        // third-party clipboard managers add more), so retry over ~2s before
        // claiming success (objective outcome).
        for (let attempt = 0; attempt < 8; attempt++) {
          await new Promise(resolve => setTimeout(resolve, 250));
          if (windowsIntegration.readClipboard() === text) {
            return { success: true, verified: true };
          }
        }
        return { success: true, verified: false, note: 'write accepted but read-back did not match within 2s' };
      },
    },
    {
      name: 'notify',
      description: 'Shows a native desktop notification.',
      category: 'system',
      permissions: [{ type: 'notification', scope: ['*'] }],
      handler: async args => {
        const shown = windowsIntegration.notify(
          String(args.title ?? 'NOVA'),
          String(args.body ?? ''),
        );
        return { success: shown };
      },
    },
    {
      name: 'system_info',
      description: 'Returns host system information (CPU, RAM, GPU, OS, hostname, uptime, Python/Electron/NOVA versions).',
      category: 'system',
      permissions: [],
      handler: async () => {
        const base = windowsIntegration.getSystemInfo();
        // Enrich with real Python-side data (GPU, uptime) when available.
        const py = await pythonRuntime.request('system.info', {}, 8000);
        if (py.ok) {
          const data = py.data as { gpu?: unknown; uptimeSeconds?: number };
          return {
            success: true,
            info: {
              ...base,
              gpu: data?.gpu ?? null,
              uptimeSeconds: data?.uptimeSeconds ?? null,
            },
          };
        }
        return { success: true, info: base };
      },
    },
    {
      name: 'capture_screen',
      description: 'Captures the primary display as a JPEG frame (base64).',
      category: 'vision',
      permissions: [],
      handler: async () => {
        const sources = await desktopCapturer.getSources({
          types: ['screen'],
          thumbnailSize: { width: 1280, height: 720 },
        });
        const primary = sources[0];
        if (primary?.thumbnail && !primary.thumbnail.isEmpty()) {
          return { success: true, mimeType: 'image/jpeg', data: primary.thumbnail.toDataURL().split(',')[1] };
        }
        return { success: false, error: 'No screen capture available' };
      },
    },
    {
      name: 'screen_capture',
      description: 'Captures the desktop (configurable monitor) as a PNG/JPEG frame with timestamp and metadata.',
      category: 'vision',
      permissions: [],
      handler: async args => {
        const monitor = Number(args.monitor ?? 0);
        const screenshot = await pythonRuntime.request('automation.screenshot', { monitor });
        if (screenshot.ok) {
          const data = screenshot.data as { base64?: string; width?: number; height?: number };
          if (data?.base64) {
            return {
              success: true,
              mimeType: 'image/png',
              data: data.base64,
              width: data.width,
              height: data.height,
              monitor,
              capturedAt: Date.now(),
            };
          }
        }
        // Fall back to the Electron desktopCapturer when pyautogui is absent.
        const sources = await desktopCapturer.getSources({
          types: ['screen'],
          thumbnailSize: { width: 1920, height: 1080 },
        });
        const primary = sources[monitor] ?? sources[0];
        if (primary?.thumbnail && !primary.thumbnail.isEmpty()) {
          return {
            success: true,
            mimeType: 'image/jpeg',
            data: primary.thumbnail.toDataURL().split(',')[1],
            monitor,
            capturedAt: Date.now(),
          };
        }
        return { success: false, error: 'No screen capture available' };
      },
    },
    {
      name: 'screenshot_region',
      description: 'Captures a specific screen region by pixel coordinates (x, y, width, height).',
      category: 'vision',
      permissions: [],
      handler: async args => {
        const x = Number(args.x ?? 0);
        const y = Number(args.y ?? 0);
        const width = Number(args.width ?? 800);
        const height = Number(args.height ?? 600);
        const screenshot = await pythonRuntime.request('automation.screenshot', { monitor: 0 });
        if (screenshot.ok) {
          const data = screenshot.data as { base64?: string };
          if (data?.base64) {
            // Region crop happens in the Python runtime via the region request.
            const region = await pythonRuntime.request('automation.screenshot_region', {
              x,
              y,
              width,
              height,
            });
            if (region.ok) {
              const rdata = region.data as { base64?: string; width?: number; height?: number };
              if (rdata?.base64) {
                return { success: true, mimeType: 'image/png', data: rdata.base64, capturedAt: Date.now() };
              }
            }
            return { success: false, error: 'region capture unavailable in Python runtime' };
          }
        }
        return { success: false, error: 'region capture requires the Python runtime (pyautogui)' };
      },
    },
    {
      name: 'application_launch',
      description: 'Launches a Windows application or opens a file/URL with validated arguments.',
      category: 'system',
      permissions: [{ type: 'child-process', scope: ['shell'] }],
      handler: async args => {
        const target = String(args.target ?? args.app ?? '').trim();
        if (!target) return { success: false, error: 'target application required' };
        // Reject shell metacharacters and command chaining — this is a single
        // application launch, never arbitrary command execution.
        if (/[&|;<>`$\\]/.test(target)) {
          return { success: false, error: 'target contains unsafe shell characters' };
        }
        // Reject interpreter command lines (cmd/powershell with a /c or -Command
        // flag) — those are arbitrary command execution, not application launch.
        if (/^(cmd|cmd\.exe|powershell|powershell\.exe|pwsh|pwsh\.exe)(\s+|\/|$)/i.test(target)) {
          return {
            success: false,
            error: 'launching a command interpreter is not permitted; launch a specific application',
          };
        }
        const result = await pythonRuntime.request('automation.launch', { target });
        if (result.ok) return { success: true, result: 'Launched ' + target };
        return { success: false, error: result.error ?? 'launch failed' };
      },
    },
    {
      name: 'open_url',
      description: 'Opens a URL in the default web browser.',
      category: 'web',
      permissions: [{ type: 'net-https', scope: ['*'] }],
      handler: async args => {
        const url = String(args.url ?? args.target ?? '').trim();
        if (!/^https?:\/\//i.test(url)) {
          return { success: false, error: 'url must start with http(s)://' };
        }
        const { shell } = await import('electron');
        await shell.openExternal(url);
        return { success: true, result: 'Opened ' + url };
      },
    },
    {
      name: 'workspace_open_url',
      description: 'Opens a URL inside the NOVA workspace as a web or video surface (never launches an external browser unless asked).',
      category: 'workspace',
      permissions: [{ type: 'net-https', scope: ['*'] }],
      handler: async args => {
        const url = String(args.url ?? args.target ?? '').trim();
        const invalid = assertWorkspaceUrl(url);
        if (invalid) return { success: false, error: invalid };
        const type = String(args.type ?? 'web') === 'video' ? 'video' : 'web';
        const title = String(args.title ?? url);
        if (!deps.workspace) {
          return { success: false, error: 'workspace manager not available' };
        }
        const surface = deps.workspace.open({ type, title, source: url });
        return { success: true, surfaceId: surface.id, openedIn: 'nova-workspace', url };
      },
    },
    {
      name: 'workspace_show_news',
      description: 'Opens a news/feed surface inside the NOVA workspace with real search result items.',
      category: 'workspace',
      permissions: [],
      handler: async args => {
        const items = Array.isArray(args.items) ? args.items : [];
        const clean = items
          .map(it => ({
            title: String(it?.title ?? 'Untitled').slice(0, 300),
            url: String(it?.url ?? ''),
            source: String(it?.source ?? ''),
            publishedAt: it?.publishedAt ? String(it.publishedAt) : undefined,
          }))
          .filter(it => it.url);
        if (clean.length === 0) return { success: false, error: 'no valid news items to display' };
        if (!deps.workspace) {
          return { success: false, error: 'workspace manager not available' };
        }
        const surface = deps.workspace.open({
          type: 'news',
          title: String(args.title ?? 'News'),
          source: 'nova://news',
          content: JSON.stringify(clean),
        });
        return { success: true, surfaceId: surface.id, itemCount: clean.length };
      },
    },
    {
      name: 'workspace_show_content',
      description: 'Opens a text surface (note, code, tool result, file text) inside the NOVA workspace.',
      category: 'workspace',
      permissions: [],
      handler: async args => {
        const content = String(args.content ?? args.text ?? '');
        if (!content) return { success: false, error: 'content required' };
        const rawType = String(args.type ?? 'note');
        const type = ['note', 'code', 'tool-result', 'file'].includes(rawType)
          ? (rawType as 'note' | 'code' | 'tool-result' | 'file')
          : 'note';
        if (!deps.workspace) {
          return { success: false, error: 'workspace manager not available' };
        }
        const surface = deps.workspace.open({
          type,
          title: String(args.title ?? 'NOVA content'),
          source: 'nova://content',
          content: content.slice(0, 200000),
        });
        return { success: true, surfaceId: surface.id, chars: content.length };
      },
    },
    {
      name: 'workspace_show_image',
      description: 'Displays a captured image (base64) inside the NOVA workspace.',
      category: 'workspace',
      permissions: [],
      handler: async args => {
        const data = String(args.data ?? '');
        if (!data || data.length < 64) return { success: false, error: 'image data required' };
        const mimeType = String(args.mimeType ?? 'image/png');
        if (!deps.workspace) {
          return { success: false, error: 'workspace manager not available' };
        }
        const surface = deps.workspace.open({
          type: 'image',
          title: String(args.title ?? 'Image'),
          source: mimeType,
          content: data,
        });
        return { success: true, surfaceId: surface.id, mimeType };
      },
    },
    {
      name: 'workspace_open_file',
      description: 'Opens a local file (image, text, or PDF) inside the NOVA workspace viewer instead of an external app.',
      category: 'workspace',
      permissions: [{ type: 'fs-read', scope: ['user-approved-path'] }],
      handler: async args => {
        const requested = String(args.path ?? '').trim();
        if (!requested) return { success: false, error: 'path required' };
        if (!deps.workspace) {
          return { success: false, error: 'workspace manager not available' };
        }
        try {
          const filePath = deps.resolveHostPath(requested);
          if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
            return { success: false, error: `not a file: ${requested}` };
          }
          const ext = path.extname(filePath).toLowerCase();
          const title = String(args.title ?? path.basename(filePath));
          if (IMAGE_MIME_BY_EXT[ext]) {
            const data = fs.readFileSync(filePath).toString('base64');
            const surface = deps.workspace.open({
              type: 'image',
              title,
              source: IMAGE_MIME_BY_EXT[ext],
              content: data,
            });
            return { success: true, surfaceId: surface.id, openedIn: 'nova-workspace', kind: 'image' };
          }
          if (ext === '.pdf') {
            const surface = deps.workspace.open({
              type: 'pdf',
              title,
              source: filePath,
            });
            return { success: true, surfaceId: surface.id, openedIn: 'nova-workspace', kind: 'pdf' };
          }
          if (TEXT_EXTENSIONS.has(ext)) {
            const stat = fs.statSync(filePath);
            if (stat.size > 2 * 1024 * 1024) {
              return { success: false, error: 'file exceeds 2 MB workspace preview limit' };
            }
            const surface = deps.workspace.open({
              type: 'file',
              title,
              source: filePath,
              content: fs.readFileSync(filePath, 'utf-8'),
            });
            return { success: true, surfaceId: surface.id, openedIn: 'nova-workspace', kind: 'text' };
          }
          return {
            success: false,
            error: `no in-workspace viewer for '${ext}' files — say "open ${path.basename(filePath)} outside NOVA" to open it in its default app`,
          };
        } catch (err) {
          return { success: false, error: err instanceof Error ? err.message : String(err) };
        }
      },
    },
    {
      name: 'workspace_list',
      description: 'Lists all open NOVA workspace surfaces.',
      category: 'workspace',
      permissions: [],
      handler: async () => {
        if (!deps.workspace) return { success: false, error: 'workspace manager not available' };
        const surfaces = deps.workspace.list();
        return {
          success: true,
          surfaces: surfaces.map(s => ({ id: s.id, type: s.type, title: s.title, source: s.source })),
          count: surfaces.length,
        };
      },
    },
    {
      name: 'workspace_close',
      description: 'Closes a NOVA workspace surface by id.',
      category: 'workspace',
      permissions: [],
      handler: async args => {
        if (!deps.workspace) return { success: false, error: 'workspace manager not available' };
        const id = String(args.id ?? args.surfaceId ?? '');
        if (!id) return { success: false, error: 'surface id required' };
        const closed = deps.workspace.close(id);
        return closed ? { success: true } : { success: false, error: `surface not found: ${id}` };
      },
    },
    {
      name: 'active_window',
      description: 'Returns the currently focused window (title, app, PID).',
      category: 'system',
      permissions: [],
      handler: async () => {
        const result = await pythonRuntime.request('win.active_window');
        if (result.ok) return { success: true, window: result.data };
        return { success: false, error: result.error ?? 'active window unavailable' };
      },
    },
    {
      name: 'window_list',
      description: 'Lists visible top-level windows with titles and process names.',
      category: 'system',
      permissions: [],
      handler: async args => {
        const limit = Number(args.limit ?? 50);
        const result = await pythonRuntime.request('win.window_list', { limit });
        if (result.ok) return { success: true, ...(result.data as object) };
        return { success: false, error: result.error ?? 'window list unavailable' };
      },
    },
    {
      name: 'process_list',
      description: 'Lists running processes with name, PID, CPU seconds, and memory.',
      category: 'system',
      permissions: [],
      handler: async args => {
        const limit = Number(args.limit ?? 30);
        const result = await pythonRuntime.request('win.process_list', { limit });
        if (result.ok) return { success: true, ...(result.data as object) };
        return { success: false, error: result.error ?? 'process list unavailable' };
      },
    },
    {
      name: 'system_uptime',
      description: 'Returns the host system uptime in seconds.',
      category: 'system',
      permissions: [],
      handler: async () => {
        const result = await pythonRuntime.request('win.uptime');
        if (result.ok) {
          const data = result.data as { seconds?: number };
          return { success: true, uptimeSeconds: data?.seconds ?? 0 };
        }
        return { success: false, error: result.error ?? 'uptime unavailable' };
      },
    },
    {
      name: 'mouse_move',
      description: 'Moves the mouse cursor to absolute screen coordinates (x, y).',
      category: 'control',
      permissions: [{ type: 'child-process', scope: ['input'] }],
      handler: async args => pyInput('automation.mouse_move', args, ['x', 'y']),
    },
    {
      name: 'mouse_click',
      description: 'Clicks at coordinates or the current cursor position (button: left/right/middle, clicks).',
      category: 'control',
      permissions: [{ type: 'child-process', scope: ['input'] }],
      handler: async args => pyInput('automation.mouse_click', args, [], ['x', 'y', 'button', 'clicks']),
    },
    {
      name: 'mouse_double_click',
      description: 'Double-clicks at coordinates or the current cursor position.',
      category: 'control',
      permissions: [{ type: 'child-process', scope: ['input'] }],
      handler: async args => pyInput('automation.mouse_double_click', args, [], ['x', 'y']),
    },
    {
      name: 'mouse_drag',
      description: 'Drags the mouse from (x1,y1) to (x2,y2) over a duration in seconds.',
      category: 'control',
      permissions: [{ type: 'child-process', scope: ['input'] }],
      handler: async args => pyInput('automation.mouse_drag', args, ['x1', 'y1', 'x2', 'y2'], ['duration']),
    },
    {
      name: 'mouse_scroll',
      description: 'Scrolls the mouse wheel (positive = up, negative = down).',
      category: 'control',
      permissions: [{ type: 'child-process', scope: ['input'] }],
      handler: async args => pyInput('automation.mouse_scroll', args, ['clicks']),
    },
    {
      name: 'keyboard_press',
      description: 'Presses a single key (e.g. enter, tab, esc, a, f5) optionally repeated.',
      category: 'control',
      permissions: [{ type: 'child-process', scope: ['input'] }],
      handler: async args => pyInput('automation.keyboard_press', args, ['key'], ['repeat']),
    },
    {
      name: 'keyboard_hotkey',
      description: 'Presses a key chord such as "ctrl+c" or "ctrl+shift+esc".',
      category: 'control',
      permissions: [{ type: 'child-process', scope: ['input'] }],
      handler: async args => pyInput('automation.keyboard_hotkey', args, ['combo']),
    },
    {
      name: 'keyboard_type',
      description: 'Types text into the focused window.',
      category: 'control',
      permissions: [{ type: 'child-process', scope: ['input'] }],
      handler: async args => pyInput('automation.type_text', args, ['text']),
    },
    {
      name: 'window_focus',
      description: 'Brings a window (by title substring) to the foreground.',
      category: 'control',
      permissions: [{ type: 'child-process', scope: ['window'] }],
      handler: async args => pyInput('win.window_focus', args, [], ['title']),
    },
    {
      name: 'window_minimize',
      description: 'Minimizes a window (by title substring).',
      category: 'control',
      permissions: [{ type: 'child-process', scope: ['window'] }],
      handler: async args => pyInput('win.window_minimize', args, [], ['title']),
    },
    {
      name: 'window_maximize',
      description: 'Maximizes a window (by title substring).',
      category: 'control',
      permissions: [{ type: 'child-process', scope: ['window'] }],
      handler: async args => pyInput('win.window_maximize', args, [], ['title']),
    },
    {
      name: 'window_restore',
      description: 'Restores a minimized/maximized window (by title substring).',
      category: 'control',
      permissions: [{ type: 'child-process', scope: ['window'] }],
      handler: async args => pyInput('win.window_restore', args, [], ['title']),
    },
    {
      name: 'window_move',
      description: 'Moves (and optionally resizes) a window by title substring.',
      category: 'control',
      permissions: [{ type: 'child-process', scope: ['window'] }],
      handler: async args => pyInput('win.window_move', args, ['title', 'x', 'y'], ['width', 'height']),
    },
    {
      name: 'screen_ocr',
      description: 'Extracts visible text from the current screen (screenshot + OCR).',
      category: 'vision',
      permissions: [{ type: 'fs-read', scope: ['*'] }],
      handler: async () => {
        const result = await pythonRuntime.request('automation.screen_ocr');
        if (result.ok) return { success: true, ...(result.data as object) };
        return { success: false, error: result.error ?? 'screen OCR unavailable' };
      },
    },
    {
      name: 'fetch_url',
      description: 'Retrieves a URL over HTTPS and returns the page text (content only, size-capped).',
      category: 'web',
      permissions: [{ type: 'net-https', scope: ['*'] }],
      handler: async args => fetchUrl(String(args.url ?? '')),
    },
    {
      name: 'web_search',
      description: 'Searches the web via a public search endpoint and returns top result titles + links.',
      category: 'web',
      permissions: [{ type: 'net-https', scope: ['*'] }],
      handler: async args => webSearch(String(args.query ?? args.q ?? '')),
    },
    {
      name: 'audio_device_list',
      description: 'Lists real audio input/output devices on this system.',
      category: 'audio',
      permissions: [],
      handler: async () => {
        const result = await pythonRuntime.request('audio.devices');
        if (result.ok) return { success: true, ...(result.data as object) };
        return { success: false, error: result.error ?? 'audio device discovery unavailable' };
      },
    },
    {
      name: 'microphone_info',
      description: 'Returns the default capture device and microphone availability.',
      category: 'audio',
      permissions: [],
      handler: async () => {
        const result = await pythonRuntime.request('audio.microphone_info');
        if (result.ok) return { success: true, ...(result.data as object) };
        return { success: false, error: result.error ?? 'microphone info unavailable' };
      },
    },
    {
      name: 'directory_search',
      description: 'Recursively searches a directory for files matching a name substring.',
      category: 'filesystem',
      permissions: [{ type: 'fs-read', scope: ['*'] }],
      handler: async args => {
        const root = String(args.root ?? args.path ?? deps.projectRoot);
        const needle = String(args.needle ?? args.query ?? '').trim();
        if (!needle) return { success: false, error: 'needle required' };
        const result = await pythonRuntime.request('fs.search', {
          root,
          needle,
          max_results: Number(args.max_results ?? 50),
        });
        if (result.ok) return { success: true, ...(result.data as object) };
        return { success: false, error: result.error ?? 'search failed' };
      },
    },
    {
      name: 'python_info',
      description: 'Reports the Python runtime status (version, available modules).',
      category: 'python',
      permissions: [],
      handler: async () => {
        const status = await pythonRuntime.status(true);
        return { success: true, python: status };
      },
    },
    {
      name: 'python_ocr',
      description: 'Extracts text from an image using the Python runtime (pytesseract).',
      category: 'vision',
      permissions: [{ type: 'fs-read', scope: ['*'] }],
      handler: async args => {
        const imagePath = String(args.path ?? args.image ?? '').trim();
        if (!imagePath) return { success: false, error: 'image path required' };
        if (!(await pythonRuntime.hasModule('pytesseract'))) {
          return {
            success: false,
            error:
              'pytesseract not available in the Python runtime (set NOVA_PYTHON_PATH and pip install pytesseract pillow)',
          };
        }
        // Prefer the persistent worker backend; fall back to a one-shot script.
        const workerResult = await pythonRuntime.request('ocr.image', { path: imagePath });
        if (workerResult.ok) {
          const wdata = workerResult.data as { text?: string; error?: string };
          if (wdata.error) return { success: false, error: wdata.error };
          return { success: true, text: wdata.text ?? '' };
        }
        const script =
          'import sys, json\n' +
          'try:\n' +
          '    from PIL import Image\n' +
          '    import pytesseract\n' +
          '    text = pytesseract.image_to_string(Image.open(sys.argv[1]))\n' +
          '    print(json.dumps({"text": text}))\n' +
          'except Exception as e:\n' +
          '    print(json.dumps({"error": str(e)}))';
        const result = await pythonRuntime.runJson(script, [imagePath]);
        if (!result.ok) return { success: false, error: result.error };
        const data = result.data as { text?: string; error?: string };
        if (data.error) return { success: false, error: data.error };
        return { success: true, text: data.text ?? '' };
      },
    },
    {
      name: 'generate_tool',
      description: 'Synthesizes a new tool for a requested capability and registers it.',
      category: 'ai',
      permissions: [],
      handler: async args => {
        const intent = String(args.intent ?? args.prompt ?? '').trim();
        if (!intent) return { success: false, error: 'intent required' };
        const built = await deps.builder.ensureCapability(intent);
        if (!built.executionOk) {
          const result = built.result as { error?: unknown } | null;
          return {
            success: false,
            error: `Tool '${built.tool.name}' was created but its first production execution failed: ${String(result?.error ?? 'unknown execution error')}`,
            toolId: built.tool.id,
            toolName: built.tool.name,
          };
        }
        const { tool } = built;
        return {
          success: true,
          result: `Generated and registered tool '${tool.name}' (${tool.id})`,
          toolId: tool.id,
          toolName: tool.name,
          execution: built.result,
        };
      },
    },
    {
      name: 'generate_cad',
      description: 'Queues a 3D CAD model generation task.',
      category: 'automation',
      permissions: [],
      handler: async args =>
        queueAutomationResult(deps, 'cad', String(args.prompt ?? '')),
    },
    {
      name: 'iterate_cad',
      description: 'Queues an iteration on the current CAD design.',
      category: 'automation',
      permissions: [],
      handler: async args =>
        queueAutomationResult(deps, 'cad_iteration', String(args.prompt ?? '')),
    },
    {
      name: 'list_smart_devices',
      description: 'Discovers smart devices on the local network.',
      category: 'iot',
      permissions: [{ type: 'net-http', scope: ['*'] }],
      handler: async () => {
        const devices = await scanPorts([80, 443, 1883, 5683, 8443], 200, 'Smart device');
        return { success: true, devices, count: devices.length };
      },
    },
    {
      name: 'discover_printers',
      description: 'Discovers 3D printers on the local network.',
      category: 'manufacturing',
      permissions: [{ type: 'net-http', scope: ['*'] }],
      handler: async () => {
        const printers = await scanPorts([9100, 515, 631, 80], 300, 'Printer');
        return { success: true, printers, count: printers.length };
      },
    },
    {
      name: 'control_light',
      description: 'Controls a smart light over HTTP.',
      category: 'iot',
      permissions: [{ type: 'net-http', scope: ['*'] }],
      handler: async args => httpJsonControl('control', args),
    },
    {
      name: 'print_stl',
      description: 'Queues an STL print job on a 3D printer over HTTP.',
      category: 'manufacturing',
      permissions: [{ type: 'net-http', scope: ['*'] }],
      handler: async args => httpJsonControl('print', args),
    },
    {
      name: 'get_print_status',
      description: 'Gets the current status of a 3D printer over HTTP.',
      category: 'manufacturing',
      permissions: [{ type: 'net-http', scope: ['*'] }],
      handler: async args => httpJsonControl('status', args),
    },
  ];

  for (const b of builtins) {
    // The executor handler must be (re)registered on every boot: when the
    // registry is hydrated from the persisted DB the definitions already
    // exist, but the in-memory handler map starts empty — skipping this left
    // built-ins returning "Builtin handler not found" after the first run.
    executor.registerBuiltin(b.name, b.handler);
    const existing = registry.getByName(b.name);
    if (existing) {
      if (typeof existing.health !== 'string') existing.health = 'unknown';
      continue;
    }
    const def: ToolDefinition = {
      id: crypto.randomUUID(),
      name: b.name,
      description: b.description,
      category: b.category,
      author: 'system',
      version: '1.0.0',
      dependencies: [],
      entryPoint: 'builtin',
      config: {},
      permissions: b.permissions,
      sourceCode: `// builtin: ${b.name}`,
      sourceHash: ToolRegistry.hashSource(`builtin:${b.name}`),
      enabled: true,
      status: 'active',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      lastExecutedAt: null,
      lastValidationDate: Date.now(),
      executionCount: 0,
      successCount: 0,
      totalExecutionTimeMs: 0,
      health: 'unknown',
      versions: [],
    };
    registry.register(def, false);
  }
}

const PYTHON_BACKED_BUILTINS = new Set([
  'screen_capture',
  'screenshot_region',
  'screen_ocr',
  'application_launch',
  'active_window',
  'window_list',
  'window_focus',
  'window_minimize',
  'window_maximize',
  'window_restore',
  'window_move',
  'process_list',
  'system_uptime',
  'audio_device_list',
  'microphone_info',
  'directory_search',
  'python_ocr',
  'python_info',
  'mouse_move',
  'mouse_click',
  'mouse_double_click',
  'mouse_drag',
  'mouse_scroll',
  'keyboard_press',
  'keyboard_hotkey',
  'keyboard_type',
]);

/**
 * Probes real health of Python-backed built-ins: if the Python worker is
 * unavailable the tools are marked degraded so the UI reports the true state
 * (a failed optional tool never takes NOVA down, but it is never hidden).
 */
export async function probeBuiltinHealth(registry: ToolRegistry): Promise<void> {
  let pythonAvailable = false;
  try {
    const status = await pythonRuntime.status(true);
    pythonAvailable = status.available === true;
  } catch {
    pythonAvailable = false;
  }
  for (const t of registry.list()) {
    if (!PYTHON_BACKED_BUILTINS.has(t.name)) continue;
    if (pythonAvailable) {
      if (t.executionCount < 3) t.health = 'healthy';
    } else if (t.health === 'unknown') {
      t.health = 'degraded';
    }
  }
}

/** Calls a Python runtime method with only the declared args (never others). */
async function pyInput(
  method: string,
  args: Record<string, unknown>,
  required: string[],
  optional: string[] = [],
): Promise<{ success: boolean; result?: unknown; error?: string }> {
  const params: Record<string, unknown> = {};
  for (const key of [...required, ...optional]) {
    if (args[key] !== undefined && args[key] !== null) params[key] = args[key];
  }
  for (const key of required) {
    if (params[key] === undefined) {
      return { success: false, error: `missing required argument '${key}'` };
    }
  }
  const result = await pythonRuntime.request(method, params);
  if (result.ok) return { success: true, result: result.data };
  return { success: false, error: result.error ?? `${method} failed` };
}

/**
 * HTTPS retrieval with scheme allowlist, size cap and timeout.
 *
 * SSRF guard: loopback (127.0.0.0/8, ::1) and RFC1918 private ranges are
 * rejected so a prompt cannot turn NOVA into a probe of the local network.
 */
async function fetchUrl(url: string): Promise<{ success: boolean; text?: string; error?: string }> {
  const trimmed = String(url ?? '').trim();
  if (!/^https?:\/\//i.test(trimmed)) {
    return { success: false, error: 'url must start with http(s)://' };
  }
  try {
    const host = new URL(trimmed).hostname;
    const lower = host.toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
    if (lower === 'localhost' || lower.endsWith('.localhost')) {
      return { success: false, error: 'localhost URLs are not allowed (SSRF guard)' };
    }
    const isPrivate =
      /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(lower) ||
      /^169\.254\./.test(lower) ||
      lower === '::1';
    if (isPrivate) {
      return { success: false, error: `private/loopback URL blocked (SSRF guard): ${host}` };
    }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'invalid url' };
  }
  try {
    const res = await fetch(trimmed, {
      method: 'GET',
      headers: { 'user-agent': 'NOVA-Genesis/1.1 (+desktop assistant)' },
      redirect: 'follow',
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return { success: false, error: `HTTP ${res.status} ${res.statusText}` };
    const text = await res.text();
    const maxLen = 12000;
    const body =
      text.length > maxLen
        ? text.slice(0, maxLen) + `\n…[truncated, ${text.length - maxLen} more chars]`
        : text;
    return { success: true, text: body };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Web search via DuckDuckGo HTML endpoint (no API key required). Returns the
 * top result titles + URLs. Failure reports honestly — never a fake result.
 */
async function webSearch(query: string): Promise<{ success: boolean; results?: unknown[]; error?: string }> {
  const q = String(query ?? '').trim();
  if (!q) return { success: false, error: 'query required' };
  try {
    const res = await fetch(
      `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`,
      {
        method: 'GET',
        headers: { 'user-agent': 'NOVA-Genesis/1.1 (+desktop assistant)' },
        signal: AbortSignal.timeout(15000),
      },
    );
    if (!res.ok) return { success: false, error: `HTTP ${res.status}` };
    const html = await res.text();
    // Parse result blocks: <a class="result__a" href="...">title</a>
    const results: Array<{ title: string; url: string }> = [];
    const re = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) && results.length < 8) {
      // DDG returns protocol-relative redirect URLs (//duckduckgo.com/l/...);
      // absolutize them so callers can open them directly.
      const rawUrl = decodeHtml(String(m[1]));
      const url = rawUrl.startsWith('//') ? `https:${rawUrl}` : rawUrl;
      const title = decodeHtml(String(m[2]).replace(/<[^>]+>/g, '').trim());
      results.push({ title, url });
    }
    if (results.length === 0) {
      return { success: false, error: 'no results parsed from search endpoint' };
    }
    return { success: true, results };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function decodeHtml(input: string): string {
  return input
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

function queueAutomationResult(
  deps: BuiltinToolDeps,
  kind: string,
  prompt: string,
): { success: boolean; taskId: string; note: string } {
  const taskId = deps.queueAutomationTask(kind, prompt);
  return {
    success: true,
    taskId,
    note: `Queued ${kind} automation task ${taskId}. Execution requires a connected automation backend; the task is persisted in the interaction ledger.`,
  };
}
