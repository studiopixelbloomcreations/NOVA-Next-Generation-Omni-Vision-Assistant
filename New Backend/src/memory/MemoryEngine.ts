// New Backend — memory/MemoryEngine.ts
// Persistent local Memory Engine. Stores identity, preferences, projects,
// workflows, task history, tool knowledge and facts. Retrieval is relevant
// (ranked), never a full-database dump into prompts. Secrets are kept out by
// the sanitizer before anything is stored.
import { randomUUID } from 'node:crypto';
import type { MemoryEntry } from '../contracts/domain.js';
import { JsonFileStorage } from '../persistence/storage.js';
import { Nova2Config } from '../core/config.js';
import { sanitizeSecrets } from '../security/sanitizer.js';
import { logger } from '../core/logger.js';

/** Pluggable embedding hook (semantic retrieval). Defaults to keyword scoring. */
export interface Embedder {
  embed(text: string): Promise<number[]>;
  dim?: number;
}

/** Lightweight local hashing embedder for offline semantic-ish scoring. */
export class LocalEmbedder implements Embedder {
  async embed(text: string): Promise<number[]> {
    const words = text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    const vec = new Array(64).fill(0);
    for (const w of words) {
      let h = 0;
      for (let i = 0; i < w.length; i++) h = (h * 31 + w.charCodeAt(i)) >>> 0;
      vec[h % 64] += 1;
    }
    const norm = Math.sqrt(vec.reduce((a, b) => a + b * b, 0)) || 1;
    return vec.map(v => v / norm);
  }
}

export class MemoryEngine {
  private storage: JsonFileStorage;
  private entries: MemoryEntry[] = [];
  private embedder: Embedder;

  constructor(userData: string, embedder: Embedder = new LocalEmbedder()) {
    this.storage = new JsonFileStorage(userData, 'memory');
    const loaded = this.storage.get<MemoryEntry[]>('entries');
    this.entries = Array.isArray(loaded) ? loaded : [];
    this.embedder = embedder;
  }

  add(kind: MemoryEntry['kind'], content: string, tags: string[] = [], source?: string): MemoryEntry {
    const entry: MemoryEntry = {
      id: randomUUID(),
      kind,
      content: sanitizeSecrets(content).slice(0, 2000),
      tags,
      score: 0,
      timestamp: Date.now(),
      source,
    };
    this.entries.push(entry);
    if (this.entries.length > Nova2Config.memory.maxEntries) {
      this.entries = this.entries.slice(-Nova2Config.memory.maxEntries);
    }
    this.persist();
    return entry;
  }

  recordInteraction(input: string, output: string): MemoryEntry {
    return this.add('conversation', `User: ${input}\nNOVA: ${output.slice(0, 800)}`, ['interaction'], 'interaction');
  }

  recordToolExecution(toolName: string, success: boolean): MemoryEntry {
    return this.add('tool_knowledge', `Tool "${toolName}" execution ${success ? 'succeeded' : 'failed'}`, ['tool', toolName.toLowerCase()], 'tool_execution');
  }

  setIdentity(patch: { preferredAddress?: string; userHandle?: string }): void {
    this.add('identity', `User preferences: ${JSON.stringify(patch)}`, ['identity', 'preference'], 'identity');
  }

  getIdentity(): { preferredAddress: string } {
    const identity = this.entries.find(e => e.kind === 'identity');
    if (!identity) return { preferredAddress: 'Sir' };
    try {
      const parsed = JSON.parse(identity.content.replace('User preferences: ', ''));
      return { preferredAddress: String(parsed.preferredAddress ?? 'Sir') };
    } catch {
      return { preferredAddress: 'Sir' };
    }
  }

  /** Relevant retrieval — ranked, bounded, never a full dump. */
  async search(query: string, k = Nova2Config.memory.maxRetrieval): Promise<MemoryEntry[]> {
    const qvec = await this.embedder.embed(query);
    const scored = [];
    for (const entry of this.entries) {
      const ev = await this.embedder.embed(entry.content);
      scored.push({
        entry,
        score: this.cosine(qvec, ev) * 0.7 + this.tagOverlap(query, entry.tags) * 0.3,
      });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, Math.max(1, k)).map(s => ({ ...s.entry, score: Number(s.score.toFixed(3)) }));
  }

  private cosine(a: number[], b: number[]): number {
    let dot = 0;
    for (let i = 0; i < Math.min(a.length, b.length); i++) dot += a[i] * b[i];
    return dot; // vectors are normalized
  }

  private tagOverlap(query: string, tags: string[]): number {
    const q = query.toLowerCase();
    return tags.some(t => q.includes(t.toLowerCase())) ? 1 : 0;
  }

  recent(kind?: MemoryEntry['kind'], limit = 20): MemoryEntry[] {
    let list = [...this.entries].sort((a, b) => b.timestamp - a.timestamp);
    if (kind) list = list.filter(e => e.kind === kind);
    return list.slice(0, limit);
  }

  clear(): void {
    this.entries = [];
    this.persist();
  }

  private persist(): void {
    this.storage.set('entries', this.entries);
    this.storage.flush();
  }

  flush(): void {
    this.storage.flush();
  }

  close(): void {
    this.storage.close();
  }
}
