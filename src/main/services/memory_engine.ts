// src/main/services/memory_engine.ts
// Long-term semantic memory.
//
// NOVA stores conversation, project, tool, execution and preference memories as
// embedding-backed entries with importance scoring and time decay, and retrieves
// them by semantic similarity. Embeddings are produced by a pluggable embedder:
//   - ProviderEmbedder   — Gemini text-embedding (network, higher quality) when
//                           a key is configured at runtime.
//   - LocalEmbedder      — deterministic word + character n-gram hashing
//                           (offline, always available) used as the default and
//                           as a fallback when the network is unavailable.
// Entries are persisted to a JSON file under the app data directory.
import * as fs from 'fs';
import * as path from 'path';

export type MemoryKind =
  | 'conversation'
  | 'project'
  | 'tool'
  | 'execution'
  | 'preference'
  | 'workflow'
  | 'user-fact'
  | 'task'
  | 'workspace';

export interface MemoryEntry {
  id: string;
  kind: MemoryKind;
  content: string;
  /** Tags for quick filtering (e.g. tool name, project name). */
  tags: string[];
  importance: number; // 0..1
  /** Confidence that the memory is still true (0..1), 0.8 default. */
  confidence: number;
  /** Provenance: where the memory came from. */
  source?: string;
  accessCount: number;
  createdAt: number;
  lastAccessAt: number;
  lastConfirmedAt?: number;
  embeddingSource: 'provider' | 'local';
}

/**
 * Persistent single-user identity. The preferred form of address defaults to
 * "SIR" and is only changed when the user explicitly changes it.
 */
export interface UserIdentity {
  userId: string;
  /** Natural form of address, defaults to "Sir". */
  preferredAddress: string;
  nameIfProvided: string | null;
  preferences: Record<string, string>;
  interests: string[];
  projects: string[];
  habits: string[];
  importantContext: string[];
  createdAt: number;
  updatedAt: number;
}

export interface MemorySearchResult {
  id: string;
  kind: MemoryKind;
  content: string;
  tags: string[];
  score: number;
  timestamp: number;
}

const DIM = 256;
const DECAY_LAMBDA = 0.35; // per-day exponential decay
const MAX_ENTRIES = 4000;
const SAVE_DEBOUNCE_MS = 1500;

// ---------------------------------------------------------------------------
// Embedders
// ---------------------------------------------------------------------------

/**
 * Secrets must never enter memory. Strips credential-shaped substrings before
 * anything is stored or embedded: API keys, tokens, passwords, auth headers.
 */
export function sanitizeMemoryText(text: string): string {
  const patterns: RegExp[] = [
    // Common API key / token shapes (Google, GitHub, Slack, OpenAI, generic).
    /\b(?:AIza[0-9A-Za-z_-]{20,}|sk-[0-9A-Za-z]{20,}|gh[pousr]_[0-9A-Za-z]{20,}|xox[baprs]-[0-9A-Za-z-]{20,}|rk-live-[0-9A-Za-z]{20,})\b/g,
    // key=value / key: value / "key is value" credential pairs.
    /\b(?:api[_-]?key|apikey|password|passwd|pass|token|auth(?:orization)?|secret|credential|bearer)\s*(?:(?:is|was)\s+|:=|:|=)\s*['"]?[^\s,'"]{6,}['"]?/gi,
    // Long high-entropy strings that look like keys/tokens.
    /\b[0-9A-Za-z_-]{32,}\b/g,
  ];
  let clean = String(text ?? '');
  for (const re of patterns) clean = clean.replace(re, '[REDACTED]');
  return clean.trim();
}

/** Deterministic local embedder: hashed word + character n-grams. */
class LocalEmbedder {
  private static fnv1a(text: string): number {
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
  }

  private static bucket(key: string): number {
    return LocalEmbedder.fnv1a(key) % DIM;
  }

  public embed(text: string): number[] {
    const vec = new Array<number>(DIM).fill(0);
    const tokens = (text.toLowerCase().match(/[a-z0-9']+/g) ?? []);

    // Unigram TF.
    for (const token of tokens) vec[LocalEmbedder.bucket(token)] += 1;
    // Character 3-grams capture morphology for unknown words.
    const joined = text.toLowerCase().replace(/[^a-z0-9]+/g, '');
    if (joined.length >= 3) {
      for (let i = 0; i <= joined.length - 3; i++) {
        vec[LocalEmbedder.bucket(joined.slice(i, i + 3))] += 0.5;
      }
    }
    // L2 normalize.
    let norm = 0;
    for (const v of vec) norm += v * v;
    norm = Math.sqrt(norm);
    if (norm > 0) for (let i = 0; i < vec.length; i++) vec[i] /= norm;
    return vec;
  }
}

/** Network embedder using the Gemini text-embedding REST endpoint. */
class ProviderEmbedder {
  private apiKey = '';

  public setApiKey(key: string): void {
    this.apiKey = key;
  }

  public isConfigured(): boolean {
    return this.apiKey.trim().length > 0;
  }

  public async embed(text: string): Promise<number[] | null> {
    if (!this.isConfigured()) return null;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15000);
      const url =
        `https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent?key=${encodeURIComponent(this.apiKey)}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'models/text-embedding-004', content: { parts: [{ text }] } }),
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!res.ok) return null;
      const json = (await res.json()) as { embedding?: { values?: number[] } };
      const values = json.embedding?.values;
      if (!values || values.length === 0) return null;
      return values;
    } catch {
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
// Memory Engine
// ---------------------------------------------------------------------------

export class MemoryEngine {
  private entries: MemoryEntry[] = [];
  private vectors = new Map<string, number[]>();
  private local = new LocalEmbedder();
  private provider = new ProviderEmbedder();
  private saveTimer: NodeJS.Timeout | null = null;
  private filePath = '';
  private identity: UserIdentity | null = null;

  public setEmbeddingApiKey(key: string): void {
    this.provider.setApiKey(key);
  }

  public init(basePath: string): void {
    this.filePath = path.join(basePath, 'memory.json');
    try {
      if (fs.existsSync(this.filePath)) {
        const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf-8')) as {
          entries?: MemoryEntry[];
          vectors?: Record<string, number[]>;
          identity?: UserIdentity | null;
        };
        this.entries = Array.isArray(parsed.entries) ? parsed.entries : [];
        if (parsed.vectors) {
          for (const [id, v] of Object.entries(parsed.vectors)) {
            if (Array.isArray(v)) this.vectors.set(id, v);
          }
        }
        if (parsed.identity) this.identity = parsed.identity;
        this.prune();
      }
    } catch {
      this.entries = [];
      this.vectors = new Map();
    }
  }

  private async embed(text: string): Promise<{ vector: number[]; source: 'provider' | 'local' }> {
    if (this.provider.isConfigured()) {
      const providerVec = await this.provider.embed(text);
      if (providerVec) return { vector: providerVec, source: 'provider' };
    }
    return { vector: this.local.embed(text), source: 'local' };
  }

  private prune(): void {
    if (this.entries.length <= MAX_ENTRIES) return;
    // Drop the least important / oldest entries first.
    const scored = this.entries
      .map(e => ({ e, score: e.importance * (e.accessCount + 1) / (1 + (Date.now() - e.lastAccessAt) / 86_400_000) }))
      .sort((a, b) => a.score - b.score);
    const victims = new Set(scored.slice(0, this.entries.length - MAX_ENTRIES).map(s => s.e.id));
    this.entries = this.entries.filter(e => !victims.has(e.id));
    for (const id of victims) this.vectors.delete(id);
  }

  /** Stores a memory entry. Returns the created entry. */
  public async store(
    kind: MemoryKind,
    content: string,
    opts: { tags?: string[]; importance?: number; id?: string; source?: string; confidence?: number } = {},
  ): Promise<MemoryEntry> {
    // Secrets never enter memory: sanitize BEFORE embedding/persistence so
    // credentials cannot leak into semantic vectors either.
    const text = sanitizeMemoryText(content);
    if (!text) throw new Error('memory content must not be empty');

    const existing = this.entries.find(e => e.kind === kind && e.content === text);
    if (existing) {
      existing.importance = Math.min(1, existing.importance + 0.1);
      existing.lastAccessAt = Date.now();
      this.scheduleSave();
      return existing;
    }

    const { vector, source } = await this.embed(text);
    const entry: MemoryEntry = {
      id: opts.id ?? `${kind}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      kind,
      content: text.slice(0, 4000),
      tags: opts.tags ?? [],
      importance: Math.max(0, Math.min(1, opts.importance ?? 0.5)),
      confidence: Math.max(0, Math.min(1, opts.confidence ?? 0.8)),
      source: opts.source,
      accessCount: 0,
      createdAt: Date.now(),
      lastAccessAt: Date.now(),
      embeddingSource: source,
    };
    this.entries.push(entry);
    this.vectors.set(entry.id, vector);
    this.prune();
    this.scheduleSave();
    return entry;
  }

  public recordInteraction(input: string, output: string): Promise<MemoryEntry> {
    const content = `Q: ${input.slice(0, 800)}\nA: ${output.slice(0, 2000)}`;
    return this.store('conversation', content, { importance: 0.55, tags: ['interaction'] });
  }

  public recordToolExecution(toolName: string, success: boolean, summary?: string): Promise<MemoryEntry> {
    const content = `tool ${toolName} ${success ? 'succeeded' : 'failed'}${summary ? `: ${summary.slice(0, 400)}` : ''}`;
    return this.store('execution', content, {
      importance: success ? 0.4 : 0.65,
      tags: ['tool', toolName],
    });
  }

  public setPreference(key: string, value: string): Promise<MemoryEntry> {
    return this.store('preference', `${key}: ${value}`, { importance: 0.8, confidence: 0.9, tags: ['preference', key] });
  }

  /** Removes a memory by id (user correction: "Forget that"). */
  public forget(id: string): boolean {
    const before = this.entries.length;
    this.entries = this.entries.filter(e => e.id !== id);
    this.vectors.delete(id);
    const removed = this.entries.length < before;
    if (removed) this.scheduleSave();
    return removed;
  }

  /** Removes every memory whose content matches a substring ("forget about X"). */
  public forgetMatching(substring: string): number {
    const needle = String(substring ?? '').trim().toLowerCase();
    if (!needle) return 0;
    const victims = this.entries.filter(e => e.content.toLowerCase().includes(needle)).map(e => e.id);
    for (const id of victims) this.forget(id);
    if (victims.length > 0) this.scheduleSave();
    return victims.length;
  }

  /** Updates an existing memory (user correction: "change that preference"). */
  public updateMemory(id: string, patch: Partial<Pick<MemoryEntry, 'content' | 'importance' | 'confidence' | 'tags' | 'source'>>): MemoryEntry | null {
    const target = this.entries.find(e => e.id === id);
    if (!target) return null;
    if (patch.content !== undefined) {
      const clean = sanitizeMemoryText(patch.content);
      if (!clean) return null;
      target.content = clean.slice(0, 4000);
      // Re-embed the changed content.
      void this.embed(target.content).then(({ vector, source }) => {
        this.vectors.set(target.id, vector);
        target.embeddingSource = source;
      });
    }
    if (patch.importance !== undefined) target.importance = Math.max(0, Math.min(1, patch.importance));
    if (patch.confidence !== undefined) target.confidence = Math.max(0, Math.min(1, patch.confidence));
    if (patch.tags !== undefined) target.tags = patch.tags;
    if (patch.source !== undefined) target.source = patch.source;
    target.lastAccessAt = Date.now();
    this.scheduleSave();
    return target;
  }

  /** Confirms a memory (raises confidence, records the confirmation time). */
  public confirm(id: string): MemoryEntry | null {
    const target = this.entries.find(e => e.id === id);
    if (!target) return null;
    target.confidence = 1;
    target.lastConfirmedAt = Date.now();
    target.lastAccessAt = Date.now();
    this.scheduleSave();
    return target;
  }

  /**
   * Consolidates related preference memories into a single coherent entry.
   * Entries sharing a preference tag and with high embedding similarity are
   * merged (content combined, importance/confidence boosted). Bounded and
   * idempotent; never touches other kinds.
   */
  public async consolidate(): Promise<number> {
    const prefs = this.entries.filter(e => e.kind === 'preference');
    const merged = new Set<string>();
    let mergedCount = 0;
    for (let i = 0; i < prefs.length; i++) {
      if (merged.has(prefs[i].id)) continue;
      for (let j = i + 1; j < prefs.length; j++) {
        if (merged.has(prefs[j].id)) continue;
        const a = prefs[i];
        const b = prefs[j];
        const sharedTag = a.tags.some(t => b.tags.includes(t));
        if (!sharedTag) continue;
        const va = this.vectors.get(a.id);
        const vb = this.vectors.get(b.id);
        const sim = va && vb && a.embeddingSource === b.embeddingSource ? this.cosine(va, vb) : 0;
        if (sim < 0.55) continue;
        // Merge b into a.
        a.content = `${a.content} / ${b.content}`.slice(0, 4000);
        a.importance = Math.min(1, Math.max(a.importance, b.importance) + 0.1);
        a.confidence = Math.min(1, Math.max(a.confidence, b.confidence) + 0.05);
        a.tags = [...new Set([...a.tags, ...b.tags])];
        a.lastAccessAt = Date.now();
        merged.add(b.id);
        this.vectors.delete(b.id);
        this.entries = this.entries.filter(e => e.id !== b.id);
        mergedCount++;
      }
    }
    // Re-embed the surviving merged entries so retrieval stays accurate.
    for (const e of this.entries) {
      if (mergedCount > 0 && e.kind === 'preference' && !merged.has(e.id)) {
        const { vector, source } = await this.embed(e.content);
        this.vectors.set(e.id, vector);
        e.embeddingSource = source;
      }
    }
    if (mergedCount > 0) this.scheduleSave();
    return mergedCount;
  }

  // ---------------------------------------------------------------------------
  // Single-user identity
  // ---------------------------------------------------------------------------

  /** Returns the persistent user identity (creates it on first use). */
  public getIdentity(): UserIdentity {
    if (!this.identity) {
      this.identity = {
        userId: `user_${Date.now().toString(36)}`,
        preferredAddress: 'Sir',
        nameIfProvided: null,
        preferences: {},
        interests: [],
        projects: [],
        habits: [],
        importantContext: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      this.scheduleSave();
    }
    return this.identity;
  }

  /** Updates the persistent identity (e.g. preferredAddress -> 'Sir'). */
  public updateIdentity(patch: Partial<Omit<UserIdentity, 'userId' | 'createdAt'>>): UserIdentity {
    const identity = this.getIdentity();
    if (patch.preferredAddress !== undefined && String(patch.preferredAddress).trim()) {
      identity.preferredAddress = String(patch.preferredAddress).trim();
    }
    if (patch.nameIfProvided !== undefined) identity.nameIfProvided = patch.nameIfProvided;
    if (patch.preferences !== undefined) identity.preferences = { ...identity.preferences, ...patch.preferences };
    if (patch.interests !== undefined) identity.interests = [...new Set([...identity.interests, ...patch.interests])];
    if (patch.projects !== undefined) identity.projects = [...new Set([...identity.projects, ...patch.projects])];
    if (patch.habits !== undefined) identity.habits = [...new Set([...identity.habits, ...patch.habits])];
    if (patch.importantContext !== undefined) {
      identity.importantContext = [...new Set([...identity.importantContext, ...patch.importantContext])];
    }
    identity.updatedAt = Date.now();
    this.scheduleSave();
    return identity;
  }

  /** Forgets a single user-fact / preference by exact content match. */
  public forgetUserFact(content: string): boolean {
    const text = sanitizeMemoryText(content);
    if (!text) return false;
    const victim = this.entries.find(e => e.content === text || e.content.includes(text));
    if (!victim) return false;
    this.forget(victim.id);
    return true;
  }

  /**
   * Semantic search with importance weighting and time decay.
   *
   * Entries written while the provider embedder was unavailable (local) must
   * stay retrievable later, so the query is embedded once per embedder that is
   * currently reachable and each entry is scored against its own source. This
   * avoids the cross-dimension mismatch that a single mixed comparison would
   * cause.
   */
  public async search(query: string, k = 5, kind?: MemoryKind): Promise<MemorySearchResult[]> {
    const text = query.trim();
    if (this.entries.length === 0 || !text) return [];

    const queries: Array<{ vector: number[]; source: 'provider' | 'local' }> = [];
    if (this.provider.isConfigured()) {
      const providerVec = await this.provider.embed(text);
      if (providerVec) queries.push({ vector: providerVec, source: 'provider' });
    }
    queries.push({ vector: this.local.embed(text), source: 'local' });

    const candidates = kind ? this.entries.filter(e => e.kind === kind) : this.entries;
    const scored: Array<{ entry: MemoryEntry; score: number }> = [];
    for (const queryVec of queries) {
      for (const entry of candidates) {
        const vec = this.vectors.get(entry.id);
        if (!vec) continue;
        // Only compare vectors produced by the same embedder (dimensions match).
        if (entry.embeddingSource !== queryVec.source) continue;
        const cosine = this.cosine(vec, queryVec.vector);
        const ageDays = (Date.now() - entry.lastAccessAt) / 86_400_000;
        const decay = Math.exp(-DECAY_LAMBDA * ageDays);
        const recencyBoost = Math.min(2, 1 + entry.accessCount * 0.05);
        const score = cosine * entry.importance * decay * recencyBoost;
        if (score > 0) scored.push({ entry, score });
      }
    }

    return scored
      .sort((a, b) => b.score - a.score)
      .slice(0, k)
      .map(s => {
        s.entry.accessCount += 1;
        s.entry.lastAccessAt = Date.now();
        return {
          id: s.entry.id,
          kind: s.entry.kind,
          content: s.entry.content,
          tags: s.entry.tags,
          score: s.score,
          timestamp: s.entry.createdAt,
        };
      });
  }

  public recall(kind: MemoryKind, limit = 20): MemoryEntry[] {
    return this.entries
      .filter(e => e.kind === kind)
      .sort((a, b) => b.lastAccessAt - a.lastAccessAt)
      .slice(0, limit);
  }

  public count(): number {
    return this.entries.length;
  }

  public stats(): { entries: number; byKind: Record<string, number>; providerEmbeddings: boolean } {
    const byKind: Record<string, number> = {};
    let providerEmbeddings = 0;
    for (const e of this.entries) {
      byKind[e.kind] = (byKind[e.kind] ?? 0) + 1;
      if (e.embeddingSource === 'provider') providerEmbeddings++;
    }
    return { entries: this.entries.length, byKind, providerEmbeddings: providerEmbeddings > 0 };
  }

  private cosine(a: number[], b: number[]): number {
    let dot = 0;
    let na = 0;
    let nb = 0;
    const len = Math.min(a.length, b.length);
    for (let i = 0; i < len; i++) {
      dot += a[i] * b[i];
      na += a[i] * a[i];
      nb += b[i] * b[i];
    }
    if (na === 0 || nb === 0) return 0;
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
  }

  private scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.persist(), SAVE_DEBOUNCE_MS);
  }

  /** Flushes the in-memory store to disk (called on shutdown). */
  public persist(): void {
    if (!this.filePath) return;
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const vectors: Record<string, number[]> = {};
      for (const [id, v] of this.vectors) vectors[id] = v;
      const payload = JSON.stringify({ entries: this.entries, vectors, identity: this.identity });
      fs.writeFileSync(this.filePath, payload, 'utf-8');
    } catch {
      /* memory persistence is best-effort */
    }
  }
}

export const memoryEngine = new MemoryEngine();
