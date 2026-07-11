// src/main/db/sqlite_adapter.ts
import Database from 'better-sqlite3';
import { join } from 'path';
import { app } from 'electron';
import { IInteractionLedgerEntry } from '../../shared/ipc_protocols';

export class SqliteAdapter {
  private db: Database.Database | null = null;
  private dbPath: string = '';

  private ensureDb(): Database.Database {
    if (this.db) return this.db;

    if (!app.isReady()) {
      throw new Error('Electron app not ready');
    }

    this.dbPath = join(app.getPath('userData'), 'interaction_ledger.db');

    this.db = new Database(this.dbPath);

    // Configure WAL mode and create schema with strict constraints
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=NORMAL;
      PRAGMA foreign_keys=ON;
      PRAGMA temp_store=MEMORY;
      PRAGMA cache_size=-32768;

      CREATE TABLE IF NOT EXISTS interaction_ledger (
          uuid TEXT PRIMARY KEY NOT NULL,
          timestamp_epoch INTEGER NOT NULL,
          interaction_type TEXT NOT NULL CHECK(interaction_type IN ('voice_loop', 'tool_execution', 'automation_trigger', 'context_update')),
          raw_transcript_input TEXT,
          model_response_output TEXT,
          context_snapshot_json TEXT NOT NULL,
          embedding_vector_id TEXT NOT NULL,
          performance_latency_ms INTEGER NOT NULL CHECK(performance_latency_ms >= 0),
          created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000)
      );

      CREATE INDEX IF NOT EXISTS idx_timestamp ON interaction_ledger(timestamp_epoch);
      CREATE INDEX IF NOT EXISTS idx_interaction_type ON interaction_ledger(interaction_type);
      CREATE INDEX IF NOT EXISTS idx_created_at ON interaction_ledger(created_at);
    `);

    // Migration: ensure created_at column exists
    const columns = this.db.prepare("PRAGMA table_info(interaction_ledger)").all() as any[];
    const hasCreatedAt = columns.some((col: any) => col.name === 'created_at');
    if (!hasCreatedAt) {
      console.log('[sqlite_adapter] Adding missing created_at column to interaction_ledger');
      this.db.exec(`ALTER TABLE interaction_ledger ADD COLUMN created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000);`);
      this.db.exec(`CREATE INDEX IF NOT EXISTS idx_created_at ON interaction_ledger(created_at);`);
    }

    return this.db;
  }

  public insertInteraction(entry: IInteractionLedgerEntry): void {
    const db = this.ensureDb();
    const stmt = db.prepare(`
      INSERT INTO interaction_ledger (
        uuid, timestamp_epoch, interaction_type, raw_transcript_input,
        model_response_output, context_snapshot_json, embedding_vector_id, performance_latency_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      entry.uuid,
      entry.timestamp_epoch,
      entry.interaction_type,
      entry.raw_transcript_input,
      entry.model_response_output,
      entry.context_snapshot_json,
      entry.embedding_vector_id,
      entry.performance_latency_ms
    );
  }

  public getInteractions(limit: number = 50): IInteractionLedgerEntry[] {
    const db = this.ensureDb();
    return db.prepare(
      'SELECT * FROM interaction_ledger ORDER BY timestamp_epoch DESC LIMIT ?'
    ).all(limit) as IInteractionLedgerEntry[];
  }

  public getInteractionsByType(type: string, limit: number = 50): IInteractionLedgerEntry[] {
    const db = this.ensureDb();
    return db.prepare(
      'SELECT * FROM interaction_ledger WHERE interaction_type = ? ORDER BY timestamp_epoch DESC LIMIT ?'
    ).all(type, limit) as IInteractionLedgerEntry[];
  }

  public getInteractionsSince(sinceEpoch: number, limit: number = 100): IInteractionLedgerEntry[] {
    const db = this.ensureDb();
    return db.prepare(
      'SELECT * FROM interaction_ledger WHERE timestamp_epoch >= ? ORDER BY timestamp_epoch DESC LIMIT ?'
    ).all(sinceEpoch, limit) as IInteractionLedgerEntry[];
  }

  public close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}

export const interactionLedger = new SqliteAdapter();