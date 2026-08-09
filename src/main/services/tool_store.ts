// src/main/services/tool_store.ts
// Persistence for the Tool Registry.
//
// Primary store is SQLite (better-sqlite3, rebuilt for Electron's ABI). When
// the native binding is unavailable — e.g. headless Node test runners or a CI
// environment that skipped the native rebuild — the registry transparently
// falls back to a JSON-file store so the system still works and tests run.
import * as fs from 'fs';
import * as path from 'path';
import { ToolDefinition } from './tool_types';
import { logger } from '../core/logger';

export interface ToolStore {
  readonly kind: 'sqlite' | 'json';
  list(): ToolDefinition[];
  get(id: string): ToolDefinition | null;
  getByName(name: string): ToolDefinition | null;
  upsert(tool: ToolDefinition): void;
  remove(id: string): void;
  close(): void;
}

interface Row {
  id: string;
  data: string;
}

class JsonToolStore implements ToolStore {
  readonly kind = 'json' as const;
  private filePath: string;
  private cache: Map<string, ToolDefinition> = new Map();
  private dirty = false;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.load();
  }

  private load(): void {
    try {
      if (!fs.existsSync(this.filePath)) {
        fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
        fs.writeFileSync(this.filePath, JSON.stringify({ tools: [] }), 'utf-8');
        return;
      }
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
      const tools = Array.isArray(parsed?.tools) ? parsed.tools : [];
      for (const t of tools) this.cache.set(t.id, t);
    } catch (err) {
      logger.error('[tool_store] failed to load JSON store; starting empty', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private persist(): void {
    if (!this.dirty) return;
    try {
      const tools = Array.from(this.cache.values());
      fs.writeFileSync(this.filePath, JSON.stringify({ tools }, null, 2), 'utf-8');
      this.dirty = false;
    } catch (err) {
      logger.error('[tool_store] failed to persist JSON store', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  list(): ToolDefinition[] {
    return Array.from(this.cache.values());
  }

  get(id: string): ToolDefinition | null {
    return this.cache.get(id) ?? null;
  }

  getByName(name: string): ToolDefinition | null {
    for (const t of this.cache.values()) {
      if (t.name === name) return t;
    }
    return null;
  }

  upsert(tool: ToolDefinition): void {
    this.cache.set(tool.id, tool);
    this.dirty = true;
    this.persist();
  }

  remove(id: string): void {
    this.cache.delete(id);
    this.dirty = true;
    this.persist();
  }

  close(): void {
    this.persist();
  }
}

class SqliteToolStore implements ToolStore {
  readonly kind = 'sqlite' as const;
  private db: any;

  constructor(dbPath: string) {
    const Database = this.loadBinding();
    if (!Database) throw new Error('better-sqlite3 binding unavailable');
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tool_registry (
        id TEXT PRIMARY KEY NOT NULL,
        name TEXT NOT NULL,
        data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_tool_name ON tool_registry(name);
    `);
  }

  private loadBinding(): (new (p: string) => any) | null {
    try {
      const mod = require('better-sqlite3');
      return mod.default ?? mod;
    } catch {
      return null;
    }
  }

  list(): ToolDefinition[] {
    const rows = this.db.prepare('SELECT data FROM tool_registry').all() as Row[];
    return rows.map(r => JSON.parse(r.data) as ToolDefinition);
  }

  get(id: string): ToolDefinition | null {
    const row = this.db.prepare('SELECT data FROM tool_registry WHERE id = ?').get(id) as Row | undefined;
    return row ? (JSON.parse(row.data) as ToolDefinition) : null;
  }

  getByName(name: string): ToolDefinition | null {
    const row = this.db.prepare('SELECT data FROM tool_registry WHERE name = ?').get(name) as Row | undefined;
    return row ? (JSON.parse(row.data) as ToolDefinition) : null;
  }

  upsert(tool: ToolDefinition): void {
    this.db
      .prepare('INSERT OR REPLACE INTO tool_registry (id, name, data) VALUES (?, ?, ?)')
      .run(tool.id, tool.name, JSON.stringify(tool));
  }

  remove(id: string): void {
    this.db.prepare('DELETE FROM tool_registry WHERE id = ?').run(id);
  }

  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}

/**
 * Opens a store. Prefers SQLite; silently degrades to JSON when the native
 * binding is missing so headless tests and CI keep working.
 */
export function openToolStore(preferredPath: string): ToolStore {
  try {
    const sqlite = new SqliteToolStore(preferredPath);
    logger.info('[tool_store] opened SQLite tool store', { path: preferredPath });
    return sqlite;
  } catch (err) {
    logger.warn('[tool_store] SQLite unavailable; using JSON fallback', {
      error: err instanceof Error ? err.message : String(err),
    });
    const jsonPath = preferredPath.replace(/\.db$/, '.json');
    return new JsonToolStore(jsonPath);
  }
}
