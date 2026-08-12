// New Backend — persistence/storage.ts
// A clean, durable key/value store behind a Storage interface. Uses atomic
// JSON-file persistence so it is portable and testable in plain Node, with a
// clear seam to swap in SQLite later. All writes are atomic (write temp +
// rename) so a crash never corrupts the store.
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface Storage {
  get<T>(key: string): T | null;
  set<T>(key: string, value: T): void;
  delete(key: string): void;
  keys(): string[];
  flush(): void;
  close(): void;
}

/** A JSON-file storage partitioned into collections (one file per collection). */
export class JsonFileStorage implements Storage {
  private data = new Map<string, unknown>();
  private dirty = false;
  private readonly filePath: string;

  constructor(private readonly rootDir: string, private readonly collection: string) {
    mkdirSync(rootDir, { recursive: true });
    this.filePath = join(rootDir, `${collection}.json`);
    this.load();
  }

  private load(): void {
    if (!existsSync(this.filePath)) return;
    try {
      const raw = readFileSync(this.filePath, 'utf-8');
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      for (const [k, v] of Object.entries(parsed)) this.data.set(k, v);
    } catch {
      // Corrupt file — start fresh rather than crash.
      this.data.clear();
    }
  }

  get<T>(key: string): T | null {
    return (this.data.get(key) as T | undefined) ?? null;
  }

  set<T>(key: string, value: T): void {
    this.data.set(key, value);
    this.dirty = true;
  }

  delete(key: string): void {
    if (this.data.delete(key)) this.dirty = true;
  }

  keys(): string[] {
    return Array.from(this.data.keys());
  }

  flush(): void {
    if (!this.dirty) return;
    const obj: Record<string, unknown> = {};
    for (const [k, v] of this.data) obj[k] = v;
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf-8');
    renameSync(tmp, this.filePath);
    this.dirty = false;
  }

  close(): void {
    this.flush();
  }
}

/** A lightweight index over an array of records inside one store entry. */
export class RecordCollection<T extends { id: string }> {
  private store: Storage;
  private key: string;
  private records: T[] = [];

  constructor(store: Storage, key: string) {
    this.store = store;
    this.key = key;
    const loaded = store.get<T[]>(key);
    this.records = Array.isArray(loaded) ? loaded : [];
  }

  getById(id: string): T | null {
    return this.records.find(r => r.id === id) ?? null;
  }

  all(): T[] {
    return [...this.records];
  }

  upsert(record: T): void {
    const idx = this.records.findIndex(r => r.id === record.id);
    if (idx >= 0) this.records[idx] = record;
    else this.records.push(record);
    this.persist();
  }

  remove(id: string): boolean {
    const before = this.records.length;
    this.records = this.records.filter(r => r.id !== id);
    if (this.records.length !== before) {
      this.persist();
      return true;
    }
    return false;
  }

  replaceAll(records: T[]): void {
    this.records = [...records];
    this.persist();
  }

  private persist(): void {
    this.store.set(this.key, this.records);
  }
}

/** Recursively removes a directory tree (used for sandbox temp cleanup). */
export function removeDirSafe(target: string): void {
  try {
    rmSync(target, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

/** Ensures a directory exists. */
export function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}
