// New Backend — core/logger.ts
// Minimal structured logger (level-filtered, optional file sink). This is the
// ONLY logging facility engines may use — no scattered console.log.

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

export interface LogSink {
  write(entry: LogEntry): void;
}

export interface LogEntry {
  ts: number;
  level: LogLevel;
  message: string;
  meta?: Record<string, unknown>;
}

class Logger {
  private level: LogLevel = 'info';
  private sinks: LogSink[] = [];
  private history: LogEntry[] = [];
  private maxHistory = 500;

  configure(level: LogLevel, sink?: LogSink): void {
    this.level = level;
    if (sink) this.sinks.push(sink);
  }

  addSink(sink: LogSink): void {
    this.sinks.push(sink);
  }

  log(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
    if (LEVEL_RANK[level] < LEVEL_RANK[this.level]) return;
    const entry: LogEntry = { ts: Date.now(), level, message, meta };
    this.history.push(entry);
    if (this.history.length > this.maxHistory) this.history.shift();
    for (const sink of this.sinks) {
      try {
        sink.write(entry);
      } catch {
        /* never let logging break the app */
      }
    }
  }

  debug(message: string, meta?: Record<string, unknown>): void { this.log('debug', message, meta); }
  info(message: string, meta?: Record<string, unknown>): void { this.log('info', message, meta); }
  warn(message: string, meta?: Record<string, unknown>): void { this.log('warn', message, meta); }
  error(message: string, meta?: Record<string, unknown>): void { this.log('error', message, meta); }

  recent(limit = 200): LogEntry[] {
    return this.history.slice(-Math.max(1, limit));
  }
}

/** Console sink (default). */
export function createConsoleSink(): LogSink {
  return {
    write(entry: LogEntry): void {
      const line = `[${new Date(entry.ts).toISOString()}] ${entry.level.toUpperCase()} ${entry.message}`;
      if (entry.level === 'error') {
        // eslint-disable-next-line no-console
        console.error(line, entry.meta ?? '');
      } else if (entry.level === 'warn') {
        // eslint-disable-next-line no-console
        console.warn(line, entry.meta ?? '');
      } else {
        // eslint-disable-next-line no-console
        console.log(line, entry.meta ?? '');
      }
    },
  };
}

export const logger = new Logger();
