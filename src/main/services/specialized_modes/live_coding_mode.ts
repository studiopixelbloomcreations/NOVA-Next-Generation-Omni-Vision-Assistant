// src/main/services/specialized_modes/live_coding_mode.ts
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import { desktopCapturer } from 'electron';
import { IModePayload } from '../../../shared/ipc_protocols';
import { logger } from '../../core/logger';

/** Paths a file watcher should never descend into (cheap + safe to ignore). */
const WATCH_IGNORED = [
  'node_modules',
  'dist',
  'dist_electron',
  'build',
  '.nova-data',
  'python',
  '.git',
];

/**
 * Whether a watched relative path should be ignored (hidden entries and
 * heavy/derived directories). Mirrors the old chokidar `ignored` list.
 */
function shouldIgnore(rel: string): boolean {
  const normalized = rel.split(/[\\/]/);
  for (const segment of normalized) {
    if (!segment) continue;
    if (segment.startsWith('.')) return true;
    if (WATCH_IGNORED.includes(segment)) return true;
  }
  return false;
}

/** Minimal async-compatible wrapper over Node's native recursive fs.watch. */
class NativeFileWatcher {
  private watcher: fs.FSWatcher | null = null;
  private listeners = new Map<string, Set<(...args: any[]) => void>>();

  constructor(private rootPath: string) {}

  public watch(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        // Node >= 20 supports recursive watching on Windows; events carry a
        // path relative to the watched root.
        const watcher = fs.watch(this.rootPath, { recursive: true });
        this.watcher = watcher;
        watcher.on('change', (eventType: string, filename: string | Buffer | null) => {
          const rel = filename ? filename.toString() : '';
          if (!rel || shouldIgnore(rel)) return;
          const full = path.join(this.rootPath, rel);
          // On Windows `rename` fires for both create and delete; resolve the
          // actual direction so consumers never see a bogus 'add' for a path
          // that no longer exists.
          if (eventType === 'rename') {
            this.emit(fs.existsSync(full) ? 'add' : 'unlink', full);
          } else {
            this.emit('change', full);
          }
        });
        watcher.on('error', err => {
          this.emit('error', err);
        });
        resolve();
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  public on(event: string, handler: (...args: any[]) => void): void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(handler);
  }

  private emit(event: string, ...args: any[]): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const handler of set) {
      try {
        handler(...args);
      } catch (err) {
        logger.error('[LiveCodingMode] watcher handler error', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  public async close(): Promise<void> {
    if (this.watcher) {
      try {
        this.watcher.close();
      } catch {
        /* ignore */
      }
      this.watcher = null;
    }
    this.listeners.clear();
  }
}

export class LiveCodingMode extends EventEmitter {
  private watcher: NativeFileWatcher | null = null;
  private activeEditor = '';

  public async detectActiveEditor(): Promise<IModePayload | null> {
    try {
      const sources = await desktopCapturer.getSources({
        types: ['window'],
      });

      const editorKeywords = [
        'visual studio code',
        'code',
        'neovim',
        'nvim',
        'vim',
        'sublime text',
        'atom',
        'intellij',
        'pycharm',
        'webstorm',
        'goland',
        'rider',
        'clion',
        'phpstorm',
        'rubymine',
        'appcode',
        'datagrip',
        ' Rider',
        'rustrover',
        'fleet',
      ];

      for (const source of sources) {
        const title = source.name.toLowerCase();
        for (const keyword of editorKeywords) {
          if (title.includes(keyword)) {
            this.activeEditor = keyword.replace(/\s+/g, '-').toLowerCase();
            this.emit('mode-activated', { mode: 'LIVE_CODING', app: this.activeEditor });
            return { mode: 'LIVE_CODING', app: this.activeEditor };
          }
        }
      }

      this.activeEditor = '';
      return null;
    } catch (err) {
      logger.error('[LiveCodingMode] Editor detection failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  public async startWatching(rootPath: string): Promise<void> {
    if (this.watcher) return;

    try {
      const watcher = new NativeFileWatcher(rootPath);
      watcher.on('change', (changePath: string) => {
        this.emit('file-changed', { path: changePath, type: 'change' });
      });
      watcher.on('add', (addPath: string) => {
        this.emit('file-changed', { path: addPath, type: 'add' });
      });
      watcher.on('error', (err: unknown) => {
        logger.error('[LiveCodingMode] Watcher error', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
      await watcher.watch();
      this.watcher = watcher;
    } catch (err) {
      logger.error('[LiveCodingMode] Failed to start watcher', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  public async stopWatching(): Promise<void> {
    if (this.watcher) {
      try {
        await this.watcher.close();
      } catch {
        // ignore
      }
      this.watcher = null;
    }
  }

  public parseCompilerOutput(stderr: string): Array<{ file?: string; line?: number; message: string; severity: 'error' | 'warning' }> {
    const diagnostics: Array<{ file?: string; line?: number; message: string; severity: 'error' | 'warning' }> = [];

    const tsRegex = /error TS(\d+): (.*?)(?: \((\d+),\d+\))?$/gm;
    let match;
    while ((match = tsRegex.exec(stderr)) !== null) {
      diagnostics.push({
        message: match[2].trim(),
        severity: 'error',
      });
    }

    const genericRegex = /error\[([^\]]+)\]:\s*(.*?)$/gim;
    while ((match = genericRegex.exec(stderr)) !== null) {
      diagnostics.push({
        message: match[2].trim(),
        severity: 'error',
      });
    }

    return diagnostics;
  }
}
