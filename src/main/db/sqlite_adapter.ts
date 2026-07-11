// src/main/db/sqlite_adapter.ts
import sqlite3 from 'sqlite3';
import { join } from 'path';
import { app } from 'electron';
import { IInteractionLedgerEntry } from '../../shared/ipc_protocols';

const sqlite = sqlite3.verbose();

export class SqliteAdapter {
  private initPromise: Promise<sqlite3.Database> | null = null;

  // Opening lazily keeps module import side-effect free: app.getPath('userData')
  // is only touched once Electron is ready, and every operation awaits the same
  // in-flight init so concurrent first calls don't double-open the file.
  private ensureDb(): Promise<sqlite3.Database> {
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      if (!app.isReady()) {
        await app.whenReady();
      }
      const dbPath = join(app.getPath('userData'), 'interaction_ledger.db');

      const db = await new Promise<sqlite3.Database>((resolve, reject) => {
        const handle = new sqlite.Database(dbPath, (err) => {
          if (err) reject(err);
          else resolve(handle);
        });
      });

// Configure WAL mode and create schema with strict constraints
      await new Promise<void>((resolve, reject) => {
        db.exec(
          `
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
          -- idx_created_at created after migration ensures column exists
          `,
          (err) => {
            if (err) reject(err);
            else resolve();
          }
        );
      });

      // Migration: ensure created_at column and index exist (for existing databases without it)
      await new Promise<void>((resolve, reject) => {
        db.all("PRAGMA table_info(interaction_ledger)", [], (err, rows: any[]) => {
          if (err) {
            reject(err);
            return;
          }
          const hasCreatedAt = rows.some((col: any) => col.name === 'created_at');
          if (!hasCreatedAt) {
            console.log('[sqlite_adapter] Adding missing created_at column to interaction_ledger');
            db.exec(
              `ALTER TABLE interaction_ledger ADD COLUMN created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000);`,
              (alterErr) => {
                if (alterErr) reject(alterErr);
                else {
                  db.exec(`CREATE INDEX IF NOT EXISTS idx_created_at ON interaction_ledger(created_at);`, () => resolve());
                }
              }
            );
          } else {
            // Column exists, ensure index exists
            db.exec(`CREATE INDEX IF NOT EXISTS idx_created_at ON interaction_ledger(created_at);`, () => resolve());
          }
        });
      });

      return db;
    })();

    // Allow a retry on the next call rather than caching a rejected promise forever.
    this.initPromise.catch((err) => {
      console.error('[sqlite_adapter] interaction ledger initialization failed:', err);
      this.initPromise = null;
    });

    return this.initPromise;
  }

  public async insertInteraction(entry: IInteractionLedgerEntry): Promise<void> {
    const db = await this.ensureDb();
    return new Promise((resolve, reject) => {
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
        entry.performance_latency_ms,
        (err: Error | null) => {
          if (err) reject(err);
          else resolve();
        }
      );
      stmt.finalize();
    });
  }

  public async getInteractions(limit: number = 50): Promise<IInteractionLedgerEntry[]> {
    const db = await this.ensureDb();
    return new Promise((resolve, reject) => {
      db.all(
        'SELECT * FROM interaction_ledger ORDER BY timestamp_epoch DESC LIMIT ?',
        [limit],
        (err, rows: IInteractionLedgerEntry[]) => {
          if (err) reject(err);
          else resolve(rows);
        }
      );
    });
  }

  public async getInteractionsByType(type: string, limit: number = 50): Promise<IInteractionLedgerEntry[]> {
    const db = await this.ensureDb();
    return new Promise((resolve, reject) => {
      db.all(
        'SELECT * FROM interaction_ledger WHERE interaction_type = ? ORDER BY timestamp_epoch DESC LIMIT ?',
        [type, limit],
        (err, rows: IInteractionLedgerEntry[]) => {
          if (err) reject(err);
          else resolve(rows);
        }
      );
    });
  }

  public async getInteractionsSince(sinceEpoch: number, limit: number = 100): Promise<IInteractionLedgerEntry[]> {
    const db = await this.ensureDb();
    return new Promise((resolve, reject) => {
      db.all(
        'SELECT * FROM interaction_ledger WHERE timestamp_epoch >= ? ORDER BY timestamp_epoch DESC LIMIT ?',
        [sinceEpoch, limit],
        (err, rows: IInteractionLedgerEntry[]) => {
          if (err) reject(err);
          else resolve(rows);
        }
      );
    });
  }

  public async close(): Promise<void> {
    if (!this.initPromise) return;
    try {
      const db = await this.initPromise;
      await new Promise<void>((resolve, reject) => {
        db.close((err) => (err ? reject(err) : resolve()));
      });
    } catch (err) {
      console.error('[sqlite_adapter] close failed:', err);
    } finally {
      this.initPromise = null;
    }
  }
}

export const interactionLedger = new SqliteAdapter();