// src/main/db/graph_engine.ts
import { EventEmitter } from 'events';
import sqlite3 from 'sqlite3';
import { join } from 'path';
import { app } from 'electron';
import { IKnowledgeNode, IKnowledgeEdge } from '../../shared/ipc_protocols';

const sqlite = sqlite3.verbose();

export class GraphEngine extends EventEmitter {
  private initPromise: Promise<sqlite3.Database> | null = null;
  private graphReady = false;

  constructor() {
    super();
    // Kick off initialization once Electron is ready; consumers either await
    // ensureDb() through the public API or listen for the 'ready' event.
    void this.ensureDb().catch(() => {
      // Already logged inside ensureDb; the next call retries.
    });
  }

  private ensureDb(): Promise<sqlite3.Database> {
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      if (!app.isReady()) {
        await app.whenReady();
      }
      const dbPath = join(app.getPath('userData'), 'knowledge_graph.db');

      const db = await new Promise<sqlite3.Database>((resolve, reject) => {
        const handle = new sqlite.Database(dbPath, (err) => {
          if (err) reject(err);
          else resolve(handle);
        });
      });

      await new Promise<void>((resolve, reject) => {
        db.exec(
          `
          PRAGMA journal_mode=WAL;
          CREATE TABLE IF NOT EXISTS graph_nodes (
              node_id TEXT PRIMARY KEY NOT NULL,
              node_type TEXT NOT NULL,
              display_name TEXT NOT NULL,
              metadata_payload TEXT,
              created_at INTEGER NOT NULL,
              updated_at INTEGER NOT NULL
          );

          CREATE TABLE IF NOT EXISTS graph_edges (
              edge_id TEXT PRIMARY KEY NOT NULL,
              source_node_id TEXT NOT NULL,
              target_node_id TEXT NOT NULL,
              edge_relationship TEXT NOT NULL,
              edge_weight REAL NOT NULL DEFAULT 1.0,
              last_accessed_at INTEGER NOT NULL,
              FOREIGN KEY(source_node_id) REFERENCES graph_nodes(node_id) ON DELETE CASCADE,
              FOREIGN KEY(target_node_id) REFERENCES graph_nodes(node_id) ON DELETE CASCADE
          );

          CREATE UNIQUE INDEX IF NOT EXISTS idx_edge_directional ON graph_edges(source_node_id, target_node_id, edge_relationship);
          `,
          (err) => {
            if (err) reject(err);
            else resolve();
          }
        );
      });

      if (!this.graphReady) {
        this.graphReady = true;
        this.emit('ready');
      }
      return db;
    })();

    this.initPromise.catch((err) => {
      console.error('[graph_engine] knowledge graph initialization failed:', err);
      this.initPromise = null;
    });

    return this.initPromise;
  }

  public isReady(): boolean {
    return this.graphReady;
  }

  public async addNode(node: IKnowledgeNode): Promise<void> {
    const db = await this.ensureDb();
    return new Promise((resolve, reject) => {
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
        (err: Error | null) => {
          if (err) reject(err);
          else resolve();
        }
      );
      stmt.finalize();
    });
  }

  public async addEdge(edge: IKnowledgeEdge): Promise<void> {
    const db = await this.ensureDb();
    return new Promise((resolve, reject) => {
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
        (err: Error | null) => {
          if (err) reject(err);
          else resolve();
        }
      );
      stmt.finalize();
    });
  }

  public async getNodes(): Promise<IKnowledgeNode[]> {
    const db = await this.ensureDb();
    return new Promise((resolve, reject) => {
      db.all('SELECT * FROM graph_nodes', [], (err, rows: IKnowledgeNode[]) => {
        if (err) reject(err);
        else resolve(rows);
      });
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
      console.error('[graph_engine] close failed:', err);
    } finally {
      this.initPromise = null;
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
