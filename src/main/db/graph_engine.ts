// src/main/db/graph_engine.ts
import { EventEmitter } from 'events';
import Database from 'better-sqlite3';
import { join } from 'path';
import { IKnowledgeNode, IKnowledgeEdge } from '../../shared/ipc_protocols';

export class VectorIndex {
  private readonly efConstruction = 64;
  private readonly ml = 1 / Math.log(16);

  private vectors: Map<string, number[]> = new Map();
  private layers: Map<number, Map<string, Set<string>>> = new Map();
  private maxLayer = 0;
  private rng: () => number;

  constructor(seed: number = 42) {
    let s = seed;
    this.rng = () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };
  }

  private dot(a: number[], b: number[]): number {
    let sum = 0;
    for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
    return sum;
  }

  private norm(a: number[]): number {
    let sum = 0;
    for (let i = 0; i < a.length; i++) sum += a[i] * a[i];
    return Math.sqrt(sum);
  }

  private normalize(a: number[]): void {
    const n = this.norm(a);
    if (n === 0) return;
    for (let i = 0; i < a.length; i++) a[i] /= n;
  }

  private cosineSimilarity(a: number[], b: number[]): number {
    const na = this.norm(a);
    const nb = this.norm(b);
    if (na === 0 || nb === 0) return 0;
    return this.dot(a, b) / (na * nb);
  }

  private randomLayer(): number {
    return Math.floor(-Math.log(this.rng()) * this.ml);
  }

  private distance(a: number[], b: number[]): number {
    return 1 - this.cosineSimilarity(a, b);
  }

  addItem(id: string, vector: number[]): void {
    const v = [...vector];
    this.normalize(v);
    this.vectors.set(id, v);

    const layer = this.randomLayer();
    if (layer > this.maxLayer) {
      this.maxLayer = layer;
    }

    const entryPoint = this.selectEntryPoint(v);
    for (let lc = this.maxLayer; lc > layer; lc--) {
      const layerMap = this.layers.get(lc);
      if (layerMap && entryPoint) {
        const closest = this.greedySearchLayer(v, entryPoint, 1, lc);
        if (closest.length > 0) this.addConnections(id, closest[0].id, lc);
      }
    }
    for (let lc = Math.min(layer, this.maxLayer); lc >= 0; lc--) {
      const candidates = this.selectNeighborsHeuristic(v, this.efConstruction);
      const layerMap = this.ensureLayer(lc);
      for (const c of candidates) {
        layerMap.get(id)!.add(c.id);
        layerMap.get(c.id)!.add(id);
      }
    }
  }

  private ensureLayer(level: number): Map<string, Set<string>> {
    let lm = this.layers.get(level);
    if (!lm) {
      lm = new Map();
      this.layers.set(level, lm);
    }
    return lm;
  }

  private selectEntryPoint(query: number[]): string | null {
    let bestId: string | null = null;
    let bestDist = Infinity;
    for (let lc = this.maxLayer; lc >= 0; lc--) {
      const layerMap = this.layers.get(lc);
      if (!layerMap) continue;
      for (const [id] of layerMap) {
        const v = this.vectors.get(id);
        if (!v) continue;
        const d = this.distance(query, v);
        if (d < bestDist) {
          bestDist = d;
          bestId = id;
        }
      }
    }
    return bestId;
  }

  private greedySearchLayer(
    query: number[],
    entryId: string,
    ef: number,
    level: number,
  ): Array<{ id: string; distance: number }> {
    const visited = new Set<string>();
    const candidates: Array<{ id: string; distance: number }> = [];
    const results: Array<{ id: string; distance: number }> = [];

    const entryDist = this.distanceTo(query, entryId);
    candidates.push({ id: entryId, distance: entryDist });
    results.push({ id: entryId, distance: entryDist });
    visited.add(entryId);

    while (candidates.length > 0) {
      candidates.sort((a, b) => a.distance - b.distance);
      const closest = candidates.shift()!;
      const farthestResult = results[results.length - 1].distance;

      if (closest.distance > farthestResult && results.length >= ef) break;

      const layerMap = this.layers.get(level);
      if (!layerMap) continue;
      const neighbors = layerMap.get(closest.id);
      if (!neighbors) continue;

      for (const nId of neighbors) {
        if (visited.has(nId)) continue;
        visited.add(nId);
        const d = this.distanceTo(query, nId);
        const farthestRes = results[results.length - 1].distance;

        if (d < farthestRes || results.length < ef) {
          candidates.push({ id: nId, distance: d });
          results.push({ id: nId, distance: d });
          results.sort((a, b) => a.distance - b.distance);
          if (results.length > ef) results.pop();
        }
      }
    }
    return results;
  }

  private distanceTo(query: number[], id: string): number {
    const v = this.vectors.get(id);
    if (!v) return Infinity;
    return this.distance(query, v);
  }

  private selectNeighborsHeuristic(
    query: number[],
    _ef: number,
  ): Array<{ id: string; distance: number }> {
    if (this.vectors.size === 0) return [];
    let bestId: string | null = null;
    let bestDist = Infinity;
    for (const [id] of this.vectors) {
      const d = this.distanceTo(query, id);
      if (d < bestDist) {
        bestDist = d;
        bestId = id;
      }
    }
    if (!bestId) return [];
    return [{ id: bestId, distance: bestDist }];
  }

  private addConnections(_id: string, _neighborId: string, _level: number): void {
    const layerMap = this.ensureLayer(_level);
    let neighbors = layerMap.get(_id);
    if (!neighbors) {
      neighbors = new Set();
      layerMap.set(_id, neighbors);
    }
    neighbors.add(_neighborId);
  }

  search(
    queryVector: number[],
    k: number = 5,
  ): Array<{ id: string; distance: number; similarity: number }> {
    if (this.vectors.size === 0) return [];

    const q = [...queryVector];
    this.normalize(q);

    const entryId = this.selectEntryPoint(q);
    if (!entryId) return [];

    const startLayer = Math.min(this.maxLayer, Math.floor(Math.log(this.vectors.size) || 0));
    let currentEntry = entryId;

    for (let lc = startLayer; lc > 0; lc--) {
      const layerMap = this.layers.get(lc);
      if (!layerMap) continue;
      const res = this.greedySearchLayer(q, currentEntry, 1, lc);
      if (res.length > 0) currentEntry = res[0].id;
    }

    const results = this.greedySearchLayer(q, currentEntry, Math.max(k, this.efConstruction), 0);
    return results.slice(0, k).map(r => ({
      id: r.id,
      distance: r.distance,
      similarity: 1 - r.distance,
    }));
  }

  removeItem(id: string): void {
    this.vectors.delete(id);
    for (const [, layerMap] of this.layers) {
      layerMap.delete(id);
      for (const [, neighbors] of layerMap) {
        neighbors.delete(id);
      }
    }
  }

  size(): number {
    return this.vectors.size;
  }

  getVector(id: string): number[] | undefined {
    return this.vectors.get(id);
  }
}

function embedText(text: string): number[] {
  const dim = 128;
  const vec = new Array(dim).fill(0);
  const chars = text.toLowerCase().split('');
  let idx = 0;
  for (const ch of chars) {
    const code = ch.charCodeAt(0);
    const bucket = (code * 31 + idx) % dim;
    vec[bucket] += 1;
    idx++;
  }
  const n = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
  if (n > 0) {
    for (let i = 0; i < dim; i++) vec[i] /= n;
  }
  return vec;
}

export class GraphEngine extends EventEmitter {
  private db: Database.Database | null = null;
  private dbPath: string = '';
  private graphReady = false;
  private vectorIndex = new VectorIndex();

  constructor() {
    super();
  }

  public init(basePath: string): void {
    this.dbPath = join(basePath, 'knowledge_graph.db');
    this.ensureDb();
  }

  private ensureDb(): Database.Database {
    if (this.db) return this.db;

    this.db = new Database(this.dbPath);

    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=NORMAL;
      PRAGMA foreign_keys=ON;
      PRAGMA temp_store=MEMORY;
      PRAGMA cache_size=-32768;

      CREATE TABLE IF NOT EXISTS graph_nodes (
          node_id TEXT PRIMARY KEY NOT NULL,
          node_type TEXT NOT NULL CHECK(node_type IN ('entity', 'concept', 'project', 'file', 'tool', 'session')),
          display_name TEXT NOT NULL,
          metadata_payload TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS graph_edges (
          edge_id TEXT PRIMARY KEY NOT NULL,
          source_node_id TEXT NOT NULL,
          target_node_id TEXT NOT NULL,
          edge_relationship TEXT NOT NULL CHECK(edge_relationship IN ('contains', 'references', 'depends_on', 'derived_from', 'related_to', 'created_by')),
          edge_weight REAL NOT NULL DEFAULT 1.0 CHECK(edge_weight >= 0.0 AND edge_weight <= 1.0),
          last_accessed_at INTEGER NOT NULL,
          FOREIGN KEY(source_node_id) REFERENCES graph_nodes(node_id) ON DELETE CASCADE,
          FOREIGN KEY(target_node_id) REFERENCES graph_nodes(node_id) ON DELETE CASCADE
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_edge_directional ON graph_edges(source_node_id, target_node_id, edge_relationship);
      CREATE INDEX IF NOT EXISTS idx_edge_source ON graph_edges(source_node_id);
      CREATE INDEX IF NOT EXISTS idx_edge_target ON graph_edges(target_node_id);
      CREATE INDEX IF NOT EXISTS idx_node_type ON graph_nodes(node_type);
    `);

    if (!this.graphReady) {
      this.graphReady = true;
      this.emit('ready');
      this.emit('vector-index-ready');
    }
    return this.db;
  }

  public isReady(): boolean {
    return this.graphReady;
  }

  public async addNode(node: IKnowledgeNode): Promise<void> {
    const db = this.ensureDb();
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO graph_nodes (node_id, node_type, display_name, metadata_payload, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      node.node_id,
      node.node_type,
      node.display_name,
      node.metadata_payload,
      node.created_at,
      node.updated_at,
    );
    const text = (node.display_name || '') + ' ' + (node.node_type || '') + ' ' + (node.metadata_payload || '');
    const embedding = embedText(text);
    this.vectorIndex.addItem(node.node_id, embedding);
  }

  public async addEdge(edge: IKnowledgeEdge): Promise<void> {
    const db = this.ensureDb();
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO graph_edges (edge_id, source_node_id, target_node_id, edge_relationship, edge_weight, last_accessed_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      edge.edge_id,
      edge.source_node_id,
      edge.target_node_id,
      edge.edge_relationship,
      edge.edge_weight,
      edge.last_accessed_at,
    );
    const src = db.prepare('SELECT display_name, node_type, metadata_payload FROM graph_nodes WHERE node_id = ?').get(edge.source_node_id) as IKnowledgeNode | undefined;
    const tgt = db.prepare('SELECT display_name, node_type, metadata_payload FROM graph_nodes WHERE node_id = ?').get(edge.target_node_id) as IKnowledgeNode | undefined;
    if (src) {
      const text = (src.display_name || '') + ' ' + (src.node_type || '') + ' ' + (src.metadata_payload || '');
      this.vectorIndex.addItem(src.node_id, embedText(text));
    }
    if (tgt) {
      const text = (tgt.display_name || '') + ' ' + (tgt.node_type || '') + ' ' + (tgt.metadata_payload || '');
      this.vectorIndex.addItem(tgt.node_id, embedText(text));
    }
  }

  public searchSimilarNodes(query: string, k: number = 5): Array<{ node_id: string; similarity: number; distance: number; display_name: string }> {
    const qVec = embedText(query);
    const results = this.vectorIndex.search(qVec, k);
    const db = this.ensureDb();
    const stmt = db.prepare('SELECT node_id, display_name FROM graph_nodes WHERE node_id = ?');
    return results
      .filter(r => r.similarity >= 0.76)
      .map(r => {
        const row = stmt.get(r.id) as { node_id: string; display_name: string } | undefined;
        return { node_id: r.id, similarity: r.similarity, distance: r.distance, display_name: row?.display_name || r.id };
      });
  }

  public calculateContextRankWithVector(
    targetNodeId: string,
    query: string,
    graphShortestPathDistance: number,
    timeDeltaSec: number,
    w1: number = 0.5,
    w2: number = 0.3,
    w3: number = 0.2,
    lambda: number = 0.0001,
  ): number {
    const qVec = embedText(query);
    const targetVec = this.vectorIndex.getVector(targetNodeId);
    const vectorSimilarity = targetVec ? this.cosineSimilarity(qVec, targetVec) : 0;
    return this.calculateContextRank(vectorSimilarity, graphShortestPathDistance, timeDeltaSec, w1, w2, w3, lambda);
  }

  private cosineSimilarity(a: number[], b: number[]): number {
    const na = this.norm(a);
    const nb = this.norm(b);
    if (na === 0 || nb === 0) return 0;
    return this.dot(a, b) / (na * nb);
  }

  private dot(a: number[], b: number[]): number {
    let sum = 0;
    for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
    return sum;
  }

  private norm(a: number[]): number {
    let sum = 0;
    for (let i = 0; i < a.length; i++) sum += a[i] * a[i];
    return Math.sqrt(sum);
  }

  public calculateContextRank(
    vectorSimilarity: number,
    graphShortestPathDistance: number,
    timeDeltaSec: number,
    w1: number = 0.5,
    w2: number = 0.3,
    w3: number = 0.2,
    lambda: number = 0.0001,
  ): number {
    const proximityScore = graphShortestPathDistance > 0 ? 1 / graphShortestPathDistance : 0;
    const decayScore = Math.exp(-lambda * timeDeltaSec);

    return w1 * vectorSimilarity + w2 * proximityScore + w3 * decayScore;
  }

  public async getNodes(): Promise<IKnowledgeNode[]> {
    const db = this.ensureDb();
    return db.prepare('SELECT * FROM graph_nodes').all() as IKnowledgeNode[];
  }

  public async getNodesByType(type: string): Promise<IKnowledgeNode[]> {
    const db = this.ensureDb();
    return db
      .prepare('SELECT * FROM graph_nodes WHERE node_type = ?')
      .all(type) as IKnowledgeNode[];
  }

  public async getEdgesForNode(nodeId: string): Promise<IKnowledgeEdge[]> {
    const db = this.ensureDb();
    return db
      .prepare('SELECT * FROM graph_edges WHERE source_node_id = ? OR target_node_id = ?')
      .all(nodeId, nodeId) as IKnowledgeEdge[];
  }

  public async close(): Promise<void> {
    if (this.db) {
      this.db.close();
      this.db = null;
      this.graphReady = false;
    }
  }
}

export const graphEngine = new GraphEngine();
