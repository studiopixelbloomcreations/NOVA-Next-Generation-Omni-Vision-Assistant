// src/main/core/logger.ts
// Structured, leveled logger for the main process.
// - Writes to stdout (prefixed, timestamped) and an optional rotating file.
// - `audit()` emits security/operations events that are also persisted to the
//   audit trail by the AuditLogger service.
import * as fs from 'fs';
import * as path from 'path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LogEntry {
  ts: number;
  level: LogLevel;
  scope: string;
  message: string;
  details?: Record<string, unknown>;
}

const MAX_FILE_BYTES = 4 * 1024 * 1024;

export class NovaLogger {
  private level: LogLevel = 'info';
  private filePath: string | null = null;
  private stream: fs.WriteStream | null = null;

  constructor(scope = 'nova') {
    this.scope = scope;
  }

  private scope: string;

  public configure(opts: { level?: LogLevel; filePath?: string | null }): void {
    if (opts.level) this.level = opts.level;
    if (opts.filePath !== undefined) {
      this.setFile(opts.filePath);
    }
  }

  private setFile(filePath: string | null): void {
    if (this.stream) {
      this.stream.end();
      this.stream = null;
    }
    if (!filePath) return;
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      this.rotateIfNeeded(filePath);
      this.filePath = filePath;
      this.stream = fs.createWriteStream(filePath, { flags: 'a' });
    } catch (err) {
      // Logging must never crash the app.
      console.error('[logger] failed to open log file:', err);
      this.filePath = null;
    }
  }

  private rotateIfNeeded(filePath: string): void {
    try {
      const stat = fs.statSync(filePath);
      if (stat.size > MAX_FILE_BYTES) {
        fs.renameSync(filePath, `${filePath}.1`);
      }
    } catch {
      // No file yet — fine.
    }
  }

  public child(scope: string): NovaLogger {
    const l = new NovaLogger(scope);
    l.level = this.level;
    l.filePath = this.filePath;
    l.stream = this.stream;
    return l;
  }

  private write(level: LogLevel, message: string, details?: Record<string, unknown>): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.level]) return;
    const entry: LogEntry = { ts: Date.now(), level, scope: this.scope, message, details };
    const line = this.format(entry);
    console[level === 'error' ? 'error' : 'log'](line);
    if (this.stream) {
      try {
        this.stream.write(line + '\n');
      } catch {
        /* ignore */
      }
    }
  }

  private format(entry: LogEntry): string {
    const iso = new Date(entry.ts).toISOString();
    const details = entry.details ? ` ${JSON.stringify(entry.details)}` : '';
    return `[${iso}] [${entry.level.toUpperCase()}] [${entry.scope}] ${entry.message}${details}`;
  }

  debug(message: string, details?: Record<string, unknown>): void {
    this.write('debug', message, details);
  }
  info(message: string, details?: Record<string, unknown>): void {
    this.write('info', message, details);
  }
  warn(message: string, details?: Record<string, unknown>): void {
    this.write('warn', message, details);
  }
  error(message: string, details?: Record<string, unknown>): void {
    this.write('error', message, details);
  }

  /** Emits a security/operations audit event through the audit hook. */
  audit(action: string, outcome: 'ok' | 'denied' | 'failed', details?: Record<string, unknown>): void {
    this.write('info', `AUDIT ${action} -> ${outcome}`, details);
    try {
      this.auditSink?.({ ts: Date.now(), action, outcome, details });
    } catch {
      /* ignore */
    }
  }

  /** Called with every audit event; wired to the AuditLogger by main.ts. */
  auditSink: ((event: { ts: number; action: string; outcome: string; details?: Record<string, unknown> }) => void) | null = null;

  public close(): void {
    if (this.stream) {
      this.stream.end();
      this.stream = null;
    }
  }
}

export const logger = new NovaLogger('core');
