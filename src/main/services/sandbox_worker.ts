// src/main/services/sandbox_worker.ts
// Sandbox worker process for generated NOVA tools.
//
// ToolExecutor spawns this script as a child process (with ELECTRON_RUN_AS_NODE
// when running under Electron) and talks JSON-lines over stdio:
//
//   Request:  {"id":1,"method":"run","sourceCode":"…","sourceHash":"…",
//              "toolName":"…","memoryMb":64,"timeoutMs":2000,"context":{…}}
//   Response: {"id":1,"ok":true,"payload":{…}}
//             {"id":1,"ok":false,"error":"…"}
//   Shutdown: {"method":"shutdown"}
//
// Why a process: a generated tool that enters a synchronous infinite loop can
// never be preempted by an in-process timeout (isolated-vm's direct-call mode
// included). But it cannot survive the parent's hard wall-clock SIGKILL of this
// whole process — nor this worker's own watchdog, which self-terminates shortly
// after the execution budget expires. That closes the non-preemption gap.
//
// The worker never inherits API keys (the parent spawns it with a scrubbed
// environment), never imports electron, and only exchanges JSON-serializable
// values with the host.
import { runInNewContext } from 'vm';

interface RunRequest {
  id: number;
  method: 'run';
  sourceCode: string;
  sourceHash: string;
  toolName: string;
  memoryMb: number;
  timeoutMs: number;
  context: Record<string, unknown>;
}

interface CacheEntry {
  isolate: any;
  context: any;
  fnRef: any;
  lastUsed: number;
}

let isolatedVm: any = null;
try {
  isolatedVm = require('isolated-vm');
} catch {
  isolatedVm = null;
}

const MAX_CACHE = 5;
const compileCache = new Map<string, CacheEntry>();

function toJsonSafe(value: unknown): unknown {
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

function evictLeastRecentlyUsed(): void {
  let oldestKey: string | null = null;
  let oldestUsed = Infinity;
  for (const [key, entry] of compileCache) {
    if (entry.lastUsed < oldestUsed) {
      oldestUsed = entry.lastUsed;
      oldestKey = key;
    }
  }
  if (oldestKey) {
    const victim = compileCache.get(oldestKey);
    try {
      victim?.isolate?.dispose();
    } catch {
      /* ignore */
    }
    compileCache.delete(oldestKey);
  }
}

function resolveFn(runResult: any, jail: any, toolName: string): any {
  let fnRef = runResult;
  if (fnRef && typeof fnRef === 'object' && typeof fnRef.get === 'function') {
    // Reference-style result: resolve the declared function from the jail.
    const named = jail.get(toolName);
    fnRef = named !== undefined && named !== null ? named : fnRef;
  }
  return fnRef;
}

/** Primary sandbox: isolated-vm (real memory + timeout enforcement). */
function runWithIsolatedVm(req: RunRequest): { ok: boolean; payload?: unknown; error?: string | null } {
  let entry = compileCache.get(req.sourceHash);
  if (entry) {
    entry.lastUsed = Date.now();
  } else {
    const isolate = new isolatedVm.Isolate({ memoryLimit: req.memoryMb });
    const context = isolate.createContextSync();
    const jail = context.global;
    try {
      // The isolate provides standard ECMAScript intrinsics natively; a safe
      // console is the only host object we add.
      jail.setSync('console', { log: () => {}, warn: () => {}, error: () => {} });
    } catch {
      /* best-effort */
    }
    const script = isolate.compileScriptSync(req.sourceCode);
    const runResult = script.runSync(context, { timeout: req.timeoutMs });
    const fnRef = resolveFn(runResult, jail, req.toolName);
    if (typeof fnRef !== 'function' && !(fnRef && typeof fnRef.applySync === 'function')) {
      throw new Error(`Tool '${req.toolName}' did not evaluate to a callable function.`);
    }
    if (compileCache.size >= MAX_CACHE) evictLeastRecentlyUsed();
    entry = { isolate, context, fnRef, lastUsed: Date.now() };
    compileCache.set(req.sourceHash, entry);
  }

  const args = [req.context ?? {}, { toolName: req.toolName }];
  let raw: unknown;
  if (entry.fnRef && typeof entry.fnRef.applySync === 'function') {
    const r = entry.fnRef.applySync(undefined, args, { timeout: req.timeoutMs });
    raw = r && typeof r.copySync === 'function' ? r.copySync() : r;
  } else {
    raw = entry.fnRef(...args);
  }
  return { ok: true, payload: toJsonSafe(raw) };
}

/**
 * Fallback sandbox when isolated-vm cannot load (e.g. Electron build without
 * the native binding): a bare vm context with no process/require/timers. This
 * is not a hard security boundary on its own — the real guarantees are the
 * static security audit, the scrubbed environment, and the parent's hard
 * process kill on timeout.
 */
function runWithVm(req: RunRequest): { ok: boolean; payload?: unknown; error?: string | null } {
  const fn: any = runInNewContext(req.sourceCode, {}, {
    timeout: req.timeoutMs,
    filename: `${req.toolName}.js`,
  });
  if (typeof fn !== 'function') {
    throw new Error(`Tool '${req.toolName}' did not evaluate to a callable function.`);
  }
  const raw = fn(req.context ?? {}, { toolName: req.toolName });
  return { ok: true, payload: toJsonSafe(raw) };
}

function handleRun(req: RunRequest): void {
  let result: { ok: boolean; payload?: unknown; error?: string | null };
  try {
    result = isolatedVm ? runWithIsolatedVm(req) : runWithVm(req);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    result = {
      ok: false,
      // Only relabel genuine timeout signals (isolated-vm/vm raise a
      // "Script execution timed out" / TimeoutError); a tool's own error
      // message that merely contains "timeout" is passed through untouched.
      error: /timed out|execution timeout|TimeoutError/i.test(message)
        ? `Tool timed out after ${req.timeoutMs}ms`
        : message,
    };
  }
  process.stdout.write(`${JSON.stringify({ id: req.id, ...result })}\n`);
}

// Watchdog (secondary net): if a tool yields the event loop past its budget
// and the parent's wall-clock kill somehow misses, this worker terminates
// itself so the parent's pending request resolves with a timeout. It cannot
// fire while a synchronous runaway loop blocks the loop — that case is
// handled by the parent's hard SIGKILL, which fires first (timeoutMs + grace).
let watchdog: NodeJS.Timeout | null = null;
function armWatchdog(timeoutMs: number): void {
  if (watchdog) clearTimeout(watchdog);
  watchdog = setTimeout(() => process.exit(1), timeoutMs + 2000);
}
function disarmWatchdog(): void {
  if (watchdog) {
    clearTimeout(watchdog);
    watchdog = null;
  }
}

process.stdin.setEncoding('utf-8');
let buffer = '';
process.stdin.on('data', (chunk: string) => {
  buffer += chunk;
  let newlineIdx: number;
  while ((newlineIdx = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, newlineIdx).trim();
    buffer = buffer.slice(newlineIdx + 1);
    if (!line) continue;
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (!msg || msg.method === 'shutdown') {
      process.exit(0);
    }
    if (msg.method === 'run' && typeof msg.sourceCode === 'string') {
      armWatchdog(Number(msg.timeoutMs) || 2000);
      try {
        handleRun(msg as RunRequest);
      } finally {
        disarmWatchdog();
      }
    }
  }
});

process.stdin.on('end', () => process.exit(0));
process.stdin.on('error', () => process.exit(0));
