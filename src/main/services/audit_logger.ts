// src/main/services/audit_logger.ts
// Audit trail for security-relevant and operational events.
//
// Events are written to the `audit_events` table in the interaction ledger
// database (guarded — degrades to JSONL when SQLite is unavailable) and are
// also routed through the core logger so operators see them in the console.
import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../core/logger';

export interface AuditEvent {
  ts: number;
  action: string;
  outcome: 'ok' | 'denied' | 'failed';
  actor?: string;
  details?: Record<string, unknown>;
}

type AuditRow = { id: number; data: string };

let sqliteDb: any = null;
try {
  const Database = require('better-sqlite3');
  sqliteDb = Database.default ?? Database;
} catch {
  sqliteDb = null;
}

export class AuditLogger {
  private db: any = null;
  private jsonlPath: string | null = null;
  private queue: AuditEvent[] = [];
  private flushTimer: NodeJS.Timeout | null = null;

  constructor(opts: { dbPath?: string; jsonlPath?: string | null } = {}) {
    if (opts.dbPath && sqliteDb) {
      try {
        this.db = new sqliteDb(opts.dbPath);
        this.db.pragma('journal_mode = WAL');
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS audit_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ts INTEGER NOT NULL,
            action TEXT NOT NULL,
            outcome TEXT NOT NULL,
            data TEXT NOT NULL
          );
          CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_events(ts);
          CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_events(action);
        `);
      } catch (err) {
        logger.error('[audit_logger] SQLite audit store unavailable; using JSONL', {
          error: err instanceof Error ? err.message : String(err),
        });
        this.db = null;
      }
    }
    if (opts.jsonlPath) this.jsonlPath = opts.jsonlPath;
  }

  public record(event: {
    ts?: number;
    action: string;
    outcome?: string;
    actor?: string;
    details?: Record<string, unknown>;
  }): void {
    const outcome = (event.outcome ?? 'ok') as AuditEvent['outcome'];
    const full: AuditEvent = { ts: event.ts ?? Date.now(), ...event, outcome };
    this.queue.push(full);
    if (this.queue.length >= 20) {
      this.flush();
    } else if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        this.flush();
      }, 1000);
    }
  }

  private flush(): void {
    if (this.queue.length === 0) return;
    const batch = this.queue;
    this.queue = [];
    try {
      if (this.db) {
        const stmt = this.db.prepare(
          'INSERT INTO audit_events (ts, action, outcome, data) VALUES (?, ?, ?, ?)',
        );
        const tx = this.db.transaction((rows: AuditEvent[]) => {
          for (const row of rows) {
            stmt.run(row.ts, row.action, row.outcome, JSON.stringify({ actor: row.actor, ...row.details }));
          }
        });
        tx(batch);
      } else if (this.jsonlPath) {
        fs.mkdirSync(path.dirname(this.jsonlPath), { recursive: true });
        const lines = batch.map(e => JSON.stringify(e)).join('\n');
        fs.appendFileSync(this.jsonlPath, lines + '\n');
      }
    } catch (err) {
      logger.error('[audit_logger] failed to flush audit events', {
        error: err instanceof Error ? err.message : String(err),
        count: batch.length,
      });
    }
  }

  public recent(limit = 50): AuditEvent[] {
    this.flush();
    try {
      if (this.db) {
        const rows = this.db
          .prepare('SELECT data FROM audit_events ORDER BY ts DESC LIMIT ?')
          .all(limit) as AuditRow[];
        return rows.map(r => {
          const parsed = JSON.parse(r.data);
          return { action: '', outcome: 'ok', ...parsed };
        });
      }
    } catch {
      /* ignore */
    }
    return [];
  }

  public close(): void {
    this.flush();
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.db) {
      try {
        this.db.close();
      } catch {
        /* ignore */
      }
      this.db = null;
    }
  }
}

export const auditLogger = new AuditLogger();
