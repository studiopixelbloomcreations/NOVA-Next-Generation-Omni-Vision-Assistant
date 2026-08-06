// src/main/db/graph_engine.ts
import { EventEmitter } from 'events';
import Database from 'better-sqlite3';
import { join } from 'path';
import { app } from 'electron';
import { IKnowledgeNode, IKnowledgeEdge } from '../../shared/ipc_protocols';

export class GraphEngine extends EventEmitter {
  private db: Database.Database | null = null;
  private dbPath: string = '';
  private graphReady = false;

  constructor() {
    super();
    // Kick off initialization once Electron is ready; consumers either await
    // ensureDb() through the public API or listen for the 'ready' event.
    if (app.isReady()) {
      this.ensureDb();
    } else {
      app.whenReady().then(() => {
        this.ensureDb();
      });
    }
  }

  private ensureDb(): Database.Database {
    if (this.db) return this.db;

    if (!app.isReady()) {
      throw new Error('Electron app not ready');
    }

    this.dbPath = join(app.getPath('userData'), 'knowledge_graph.db');

    this.db = new Database(this.dbPath);

    // Configure WAL mode and create schema with strict constraints
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
      node.updated_at
    );
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
      edge.last_accessed_at
    );
  }

  public async getNodes(): Promise<IKnowledgeNode[]> {
    const db = this.ensureDb();
    return db.prepare('SELECT * FROM graph_nodes').all() as IKnowledgeNode[];
  }

  public async getNodesByType(type: string): Promise<IKnowledgeNode[]> {
    const db = this.ensureDb();
    return db.prepare('SELECT * FROM graph_nodes WHERE node_type = ?').all(type) as IKnowledgeNode[];
  }

  public async getEdgesForNode(nodeId: string): Promise<IKnowledgeEdge[]> {
    const db = this.ensureDb();
    return db.prepare(
      'SELECT * FROM graph_edges WHERE source_node_id = ? OR target_node_id = ?'
    ).all(nodeId, nodeId) as IKnowledgeEdge[];
  }

  public async close(): Promise<void> {
    if (this.db) {
      this.db.close();
      this.db = null;
      this.graphReady = false;
    }
  }

  /**
   * Calculates a dynamically weighted ranking matrix for a target context search:
   * Rank = w1 * S_Vector + w2 * G_Proximity + w3 * exp(-lambda * delta_t)
   */
  public calculateContextRank(
    vectorSimilarity: number, // S_Vector
    graphShortestPathDistance: number, // G_Proximity
    timeDeltaSec: number, // delta_t
    w1: number = 0.5,
    w2: number = 0.3,
    w3: number = 0.2,
    lambda: number = 0.0001 // decay coefficient
  ): number {
    const proximityScore = graphShortestPathDistance > 0 ? 1 / graphShortestPathDistance : 0;
    const decayScore = Math.exp(-lambda * timeDeltaSec);

    return w1 * vectorSimilarity + w2 * proximityScore + w3 * decayScore;
  }
}

export const graphEngine = new GraphEngine();