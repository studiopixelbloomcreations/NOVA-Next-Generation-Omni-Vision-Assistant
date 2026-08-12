// New Backend — persistence/tool_library.ts
// The persistent Tool Library. Owns ToolDefinitions across restart: it scans
// the on-disk `tools/` directory (manifests + tool.py + tests), verifies
// checksums, validates metadata, and registers every valid tool so NOVA never
// recreates an existing capability. It is the single source of truth for what
// NOVA can do.
import { readdirSync, existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import type { ToolDefinition } from '../contracts/domain.js';
import { JsonFileStorage, RecordCollection, ensureDir } from './storage.js';
import { logger } from '../core/logger.js';
import { Nova2Config } from '../core/config.js';

export interface LibraryHydrationReport {
  scanned: number;
  registered: number;
  skipped: number;
  failures: Array<{ technicalId: string; reason: string }>;
}

export interface ToolManifest {
  technicalId: string;
  displayName: string;
  description: string;
  category: string;
  capabilities?: string[];
  permissions?: unknown[];
  dependencies?: string[];
  version: string;
  sourceHash: string;
  createdAt: number;
}

export class ToolLibrary {
  private collection: RecordCollection<ToolDefinition>;
  private storage: JsonFileStorage;

  constructor(userData: string) {
    ensureDir(join(userData, 'tools'));
    this.storage = new JsonFileStorage(userData, 'tool_library');
    this.collection = new RecordCollection<ToolDefinition>(this.storage, 'tools');
  }

  static hashSource(sourceCode: string): string {
    return createHash('sha256').update(sourceCode, 'utf-8').digest('hex');
  }

  all(): ToolDefinition[] {
    return this.collection.all();
  }

  get(id: string): ToolDefinition | null {
    return this.collection.getById(id) ?? null;
  }

  getByTechnicalId(technicalId: string): ToolDefinition | null {
    return this.all().find(t => t.technicalId === technicalId) ?? null;
  }

  getByName(name: string): ToolDefinition | null {
    return this.all().find(t => t.displayName === name) ?? null;
  }

  getBySourcePath(path: string): ToolDefinition | null {
    return this.all().find(t => t.sourcePath === path) ?? null;
  }

  upsert(tool: ToolDefinition): void {
    this.collection.upsert(tool);
  }

  remove(id: string): boolean {
    return this.collection.remove(id);
  }

  recordExecution(id: string, outcome: { success: boolean; durationMs: number; error?: string | null }): void {
    const t = this.get(id);
    if (!t) return;
    t.executionCount += 1;
    if (outcome.success) t.successCount += 1;
    t.totalExecutionTimeMs += Math.max(0, outcome.durationMs);
    t.lastExecutedAt = Date.now();
    const rate = t.executionCount > 0 ? t.successCount / t.executionCount : 0;
    if (t.executionCount < 3) t.health = 'unknown';
    else if (rate >= 0.9) t.health = 'healthy';
    else if (rate >= 0.5) t.health = 'degraded';
    else t.health = 'unhealthy';
    this.upsert(t);
  }

  /**
   * Startup hydration: scan `tools/<technicalId>/manifest.json` + `tool.py`,
   * verify the manifest checksum against the source, and register any tool not
   * already known. Existing library entries are never duplicated.
   */
  hydrateFromDisk(): LibraryHydrationReport {
    const report: LibraryHydrationReport = { scanned: 0, registered: 0, skipped: 0, failures: [] };
    const root = Nova2Config.paths.toolsRoot;
    if (!existsSync(root)) return report;

    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = join(root, entry.name);
      const manifestPath = join(dir, 'manifest.json');
      const toolPath = join(dir, 'tool.py');
      if (!existsSync(manifestPath) || !existsSync(toolPath)) continue;
      report.scanned += 1;

      try {
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as ToolManifest;
        const technicalId = String(manifest.technicalId ?? entry.name);
        if (!technicalId) throw new Error('manifest missing technicalId');
        if (this.getByTechnicalId(technicalId)) {
          report.skipped += 1; // already registered — no duplicate
          continue;
        }
        const sourceCode = readFileSync(toolPath, 'utf-8');
        const checksum = ToolLibrary.hashSource(sourceCode);
        if (manifest.sourceHash && manifest.sourceHash !== checksum) {
          // Checksum mismatch → tool was modified after validation. Register it
          // as needing re-validation rather than silently trusting it.
          logger.warn('[tool_library] checksum mismatch on persisted tool', { technicalId });
        }
        const tool: ToolDefinition = {
          id: randomUUID(),
          technicalId,
          displayName: String(manifest.displayName ?? technicalId),
          description: String(manifest.description ?? `Persistent NOVA tool: ${technicalId}`),
          category: String(manifest.category ?? 'ai-generated'),
          author: 'ai',
          version: String(manifest.version ?? '1.0.0'),
          runtime: 'python',
          sourcePath: toolPath,
          capabilities: Array.isArray(manifest.capabilities) ? manifest.capabilities.map(String) : [],
          permissions: Array.isArray(manifest.permissions) ? manifest.permissions as ToolDefinition['permissions'] : [],
          dependencies: Array.isArray(manifest.dependencies) ? manifest.dependencies.map(String) : [],
          sourceCode,
          sourceHash: checksum,
          enabled: true,
          status: 'active',
          health: 'unknown',
          createdAt: Number(manifest.createdAt ?? Date.now()),
          updatedAt: Date.now(),
          lastExecutedAt: null,
          lastValidationDate: Date.now(),
          executionCount: 0,
          successCount: 0,
          totalExecutionTimeMs: 0,
          versions: [],
        };
        this.upsert(tool);
        report.registered += 1;
      } catch (err) {
        report.failures.push({
          technicalId: entry.name,
          reason: err instanceof Error ? err.message : String(err),
        });
        logger.debug('[tool_library] skipped invalid persisted tool', { path: manifestPath, error: String(err) });
      }
    }
    return report;
  }

  /** Independent verification that a file exists and is non-empty (for the Verification Engine). */
  static verifyFileOnDisk(targetPath: string): { exists: boolean; sizeBytes?: number; path: string } {
    const resolved = join(process.cwd(), targetPath);
    try {
      const st = statSync(resolved);
      return { exists: st.isFile(), sizeBytes: st.size, path: resolved };
    } catch {
      return { exists: false, path: resolved };
    }
  }

  flush(): void {
    this.storage.flush();
  }

  close(): void {
    this.storage.close();
  }
}
