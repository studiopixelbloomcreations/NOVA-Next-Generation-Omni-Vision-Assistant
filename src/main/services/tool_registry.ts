// src/main/services/tool_registry.ts
// Production Tool Registry.
//
// Every capability in NOVA — built-in or AI-generated — is registered here with
// full metadata: unique id, name, description, category, author, version,
// permissions, dependencies, entry point, configuration, execution history,
// success rate, average execution time, health, last validation date, signature
// hash, and enabled state.
//
// The registry is the single source of truth for what NOVA can do. The Tool
// Builder queries it first; the Orchestrator executes through it.
import { EventEmitter } from 'events';
import * as crypto from 'crypto';
import * as fs from 'fs';
import { ToolDefinition, ToolVersion } from './tool_types';
import { openToolStore, ToolStore } from './tool_store';
import { logger } from '../core/logger';
import { NovaConfig } from '../core/config';

export interface ToolHealthReport {
  id: string;
  name: string;
  status: ToolDefinition['status'];
  health: ToolDefinition['health'];
  successRate: number;
  averageExecutionMs: number;
  executionCount: number;
  lastExecutedAt: number | null;
  lastValidationDate: number | null;
  enabled: boolean;
}

export interface ToolExecutionLogEntry {
  toolId: string;
  toolName: string;
  success: boolean;
  durationMs: number;
  timestamp: number;
  error?: string | null;
}

export class ToolRegistry extends EventEmitter {
  private store: ToolStore;
  private cache = new Map<string, ToolDefinition>();
  /** In-memory execution ledger (ring buffer, newest first). */
  private executionLog: ToolExecutionLogEntry[] = [];
  private static readonly EXEC_LOG_MAX = 500;

  constructor(store: ToolStore) {
    super();
    this.store = store;
    for (const t of store.list()) this.cache.set(t.id, t);
  }

  public static hashSource(sourceCode: string): string {
    return crypto.createHash('sha256').update(sourceCode, 'utf-8').digest('hex');
  }

  /** Loads legacy tools.json (v1 manifest) entries into the registry once. */
  public migrateLegacyManifest(manifestPath: string): void {
    try {
      const raw = fs.readFileSync(manifestPath, 'utf-8');
      const parsed = JSON.parse(raw);
      const tools = Array.isArray(parsed.tools) ? parsed.tools : [];
      let migrated = 0;
      for (const t of tools) {
        if (!t?.id || this.cache.has(t.id)) continue;
        const source = typeof t.sourceCode === 'string' ? t.sourceCode : '';
        if (!source) continue;
        const def: ToolDefinition = {
          id: t.id,
          name: t.name || `tool_${t.id.slice(0, 6)}`,
          description: t.description || 'Migrated legacy tool',
          category: 'legacy',
          author: 'ai',
          version: '1.0.0',
          dependencies: [],
          entryPoint: 'sandboxed-function',
          config: {},
          permissions: Array.isArray(t.permissions) ? t.permissions : [],
          sourceCode: source,
          sourceHash: ToolRegistry.hashSource(source),
          enabled: true,
          status: t.status === 'compiled' ? 'active' : 'pending',
          createdAt: t.createdAt || Date.now(),
          updatedAt: Date.now(),
          lastExecutedAt: null,
          lastValidationDate: null,
          executionCount: 0,
          successCount: 0,
          totalExecutionTimeMs: 0,
          health: 'unknown',
          versions: [],
        };
        this.cache.set(def.id, def);
        this.store.upsert(def);
        migrated++;
      }
      if (migrated > 0) logger.info('[tool_registry] migrated legacy tools', { migrated });
    } catch (err) {
      logger.debug('[tool_registry] no legacy manifest to migrate', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  public list(): ToolDefinition[] {
    return Array.from(this.cache.values()).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  public get(id: string): ToolDefinition | null {
    return this.cache.get(id) ?? null;
  }

  public getByName(name: string): ToolDefinition | null {
    for (const t of this.cache.values()) {
      if (t.name === name) return t;
    }
    return null;
  }

  /** Semantic-ish capability search over name, description, category. */
  public searchCapability(intent: string): ToolDefinition[] {
    const terms = intent
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(t => t.length > 2);
    const scored: Array<{ tool: ToolDefinition; score: number }> = [];
    for (const tool of this.cache.values()) {
      if (!tool.enabled || tool.status === 'failed' || tool.status === 'pending') continue;
      const haystack = `${tool.name} ${tool.description} ${tool.category}`.toLowerCase();
      let score = 0;
      for (const term of terms) {
        if (haystack.includes(term)) score += 1;
      }
      // Exact name match is a strong signal.
      if (tool.name.toLowerCase() === intent.trim().toLowerCase()) score += 5;
      if (score > 0) {
        const successRate = tool.executionCount > 0 ? tool.successCount / tool.executionCount : 0;
        scored.push({ tool, score: score + successRate * 0.5 });
      }
    }
    return scored
      .sort((a, b) => b.score - a.score)
      .map(s => s.tool)
      .slice(0, 5);
  }

  /** Best candidate for an intent, or null when none is a strong match. */
  public findCapability(intent: string): ToolDefinition | null {
    const results = this.searchCapability(intent);
    if (results.length === 0) return null;
    const best = results[0];
    // Weak match: only a single generic term hit — treat as not found.
    const terms = intent
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(t => t.length > 2);
    const haystack = `${best.name} ${best.description} ${best.category}`.toLowerCase();
    const strongHits = terms.filter(t => haystack.includes(t)).length;
    if (strongHits === 0) return null;
    // Require at least half the meaningful intent terms to match.
    if (terms.length >= 3 && strongHits < Math.ceil(terms.length / 2)) return null;
    return best;
  }

  public register(tool: ToolDefinition, notify = true): ToolDefinition {
    // Fresh registration is v1.0.0. Version history only accumulates when a
    // new version is published, so rollback targets are meaningful.
    if (!tool.version) tool.version = '1.0.0';
    if (!tool.sourceHash) tool.sourceHash = ToolRegistry.hashSource(tool.sourceCode);
    tool.updatedAt = Date.now();
    this.cache.set(tool.id, tool);
    this.store.upsert(tool);
    if (notify) this.emit('tool-registered', tool);
    return tool;
  }

  /**
   * Publishes a new version of an existing tool, retaining the previous
   * version for rollback. Source hash changes trigger a new minor version.
   */
  public publishVersion(id: string, sourceCode: string, validation: ToolVersion['validation']): ToolDefinition | null {
    const tool = this.get(id);
    if (!tool) return null;

    const nextHash = ToolRegistry.hashSource(sourceCode);
    if (nextHash === tool.sourceHash) return tool;

    const prev: ToolVersion = {
      version: tool.version,
      sourceHash: tool.sourceHash,
      sourceCode: tool.sourceCode,
      createdAt: tool.updatedAt,
      validation: {
        passed: true,
        violations: [],
        testedAt: tool.lastValidationDate ?? Date.now(),
      },
    };
    tool.versions.unshift(prev);
    const maxVersions = NovaConfig.tooling.maxVersionsPerTool;
    if (tool.versions.length > maxVersions) tool.versions = tool.versions.slice(0, maxVersions);

    const [major, minor, patch] = tool.version.split('.').map(n => Number.parseInt(n, 10) || 0);
    tool.version = `${major}.${minor}.${patch + 1}`;
    tool.sourceCode = sourceCode;
    tool.sourceHash = nextHash;
    tool.lastValidationDate = validation.testedAt;
    tool.updatedAt = Date.now();
    this.store.upsert(tool);
    this.emit('tool-updated', tool);
    return tool;
  }

  /** Rolls back to the previous version (the newest retained one). */
  public rollback(id: string): ToolDefinition | null {
    const tool = this.get(id);
    if (!tool || tool.versions.length === 0) return null;
    const target = tool.versions[0];
    tool.versions.shift();
    tool.version = target.version;
    tool.sourceCode = target.sourceCode;
    tool.sourceHash = target.sourceHash;
    tool.status = 'active';
    tool.updatedAt = Date.now();
    this.store.upsert(tool);
    this.emit('tool-updated', tool);
    logger.audit('tool.rollback', 'ok', { toolId: id, toolName: tool.name, version: target.version });
    return tool;
  }

  public setEnabled(id: string, enabled: boolean): ToolDefinition | null {
    const tool = this.get(id);
    if (!tool) return null;
    tool.enabled = enabled;
    tool.status = enabled && tool.status !== 'failed' ? 'active' : tool.status;
    tool.updatedAt = Date.now();
    this.store.upsert(tool);
    this.emit('tool-state-changed', { id, enabled });
    return tool;
  }

  public remove(id: string): boolean {
    const existed = this.cache.delete(id);
    if (existed) {
      this.store.remove(id);
      this.emit('tool-removed', { id });
      logger.audit('tool.remove', 'ok', { toolId: id });
    }
    return existed;
  }

  /**
   * Records an execution outcome and recomputes success rate, average latency,
   * health, and the rolling health state.
   */
  /** Recent execution ledger entries (newest first). */
  public recentExecutions(limit = 100): ToolExecutionLogEntry[] {
    return this.executionLog.slice(0, Math.max(1, Math.min(limit, ToolRegistry.EXEC_LOG_MAX)));
  }

  public recordExecution(
    id: string,
    outcome: { success: boolean; durationMs: number; error?: string | null },
  ): void {
    const tool = this.get(id);
    if (!tool) return;
    this.executionLog.unshift({
      toolId: tool.id,
      toolName: tool.name,
      success: outcome.success,
      durationMs: Math.max(0, outcome.durationMs),
      timestamp: Date.now(),
      error: outcome.error,
    });
    if (this.executionLog.length > ToolRegistry.EXEC_LOG_MAX) {
      this.executionLog.length = ToolRegistry.EXEC_LOG_MAX;
    }
    tool.executionCount += 1;
    if (outcome.success) tool.successCount += 1;
    tool.totalExecutionTimeMs += Math.max(0, outcome.durationMs);
    tool.lastExecutedAt = Date.now();

    const successRate = tool.executionCount > 0 ? tool.successCount / tool.executionCount : 0;
    if (tool.executionCount < 3) {
      tool.health = 'unknown';
    } else if (successRate >= 0.9) {
      tool.health = 'healthy';
    } else if (successRate >= NovaConfig.tooling.healthThreshold) {
      tool.health = 'degraded';
    } else {
      tool.health = 'unhealthy';
    }
    this.store.upsert(tool);
  }

  public healthReport(): ToolHealthReport[] {
    return this.list().map(t => {
      const successRate = t.executionCount > 0 ? t.successCount / t.executionCount : 0;
      const averageExecutionMs =
        t.executionCount > 0 ? t.totalExecutionTimeMs / t.executionCount : 0;
      return {
        id: t.id,
        name: t.name,
        status: t.status,
        health: t.health,
        successRate,
        averageExecutionMs,
        executionCount: t.executionCount,
        lastExecutedAt: t.lastExecutedAt,
        lastValidationDate: t.lastValidationDate,
        enabled: t.enabled,
      };
    });
  }

  /** Metadata-only view safe to expose to the renderer (no source code). */
  public publicView(): Array<{
    id: string;
    name: string;
    description: string;
    category: string;
    version: string;
    status: string;
    health: string;
    successRate: number;
    executionCount: number;
    enabled: boolean;
  }> {
    return this.list().map(t => ({
      id: t.id,
      name: t.name,
      description: t.description,
      category: t.category,
      version: t.version,
      status: t.status,
      health: t.health,
      successRate: t.executionCount > 0 ? t.successCount / t.executionCount : 0,
      executionCount: t.executionCount,
      enabled: t.enabled,
    }));
  }

  public close(): void {
    this.store.close();
  }
}

/**
 * Opens the singleton registry. `storePath` is the SQLite path; a JSON fallback
 * is selected automatically when the native binding is missing.
 */
export function createToolRegistry(storePath: string, legacyManifestPath?: string | null): ToolRegistry {
  const store = openToolStore(storePath);
  const registry = new ToolRegistry(store);
  if (legacyManifestPath) registry.migrateLegacyManifest(legacyManifestPath);
  return registry;
}
