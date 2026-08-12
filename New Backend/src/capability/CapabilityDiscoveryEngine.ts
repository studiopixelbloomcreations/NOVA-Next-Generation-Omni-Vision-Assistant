// New Backend — capability/CapabilityDiscoveryEngine.ts
// Capability Discovery Engine. Searches ALL available capabilities (core
// built-ins, Python tools, persistent generated tools) semantically — never
// exact keyword matching alone. Returns ranked CapabilityMatch results with
// confidence, health, latency, success rate and version. If nothing satisfies
// the requirement, it reports `found=false` so the orchestrator can Forge.
import type { CapabilityMatch, ToolDefinition } from '../contracts/domain.js';
import { ToolLibrary } from '../persistence/tool_library.js';
import { logger } from '../core/logger.js';

export interface DiscoveryResult {
  found: boolean;
  best: CapabilityMatch | null;
  candidates: CapabilityMatch[];
  /** Human-readable capability catalog (fed to the planner/prompt engine). */
  catalog: string;
}

const GENERIC_STOPWORDS = new Set(['the', 'and', 'for', 'with', 'from', 'tool', 'operation', 'request', 'real', 'current', 'report', 'listing', 'please', 'my', 'a', 'an', 'of', 'to', 'on', 'in']);

export class CapabilityDiscoveryEngine {
  constructor(private readonly library: ToolLibrary) {}

  /** Semantic discovery over the whole tool library. */
  discover(intent: string): DiscoveryResult {
    const terms = this.tokenize(intent);
    const scored: Array<{ tool: ToolDefinition; score: number }> = [];

    for (const tool of this.library.all()) {
      if (!tool.enabled || tool.status === 'failed') continue;
      const haystack = `${tool.displayName} ${tool.description} ${tool.category} ${tool.technicalId} ${(tool.capabilities ?? []).join(' ')}`.toLowerCase();
      let hits = 0;
      for (const term of terms) {
        if (haystack.includes(term)) hits += 1;
      }
      // Exact name/technicalId is a strong signal.
      let score = hits;
      if (tool.displayName.toLowerCase() === intent.trim().toLowerCase()) score += 8;
      if (tool.technicalId.toLowerCase() === intent.trim().toLowerCase()) score += 8;
      if (score > 0) {
        const successRate = tool.executionCount > 0 ? tool.successCount / tool.executionCount : 0;
        const healthFactor = tool.health === 'healthy' ? 1 : tool.health === 'degraded' ? 0.6 : tool.health === 'unhealthy' ? 0.2 : 0.5;
        score += successRate * 2 * healthFactor;
        scored.push({ tool, score });
      }
    }

    scored.sort((a, b) => b.score - a.score);
    const candidates = scored.slice(0, 5).map(s => this.toMatch(s.tool, s.score, terms.length));
    const best = candidates[0] ?? null;
    const bestScored = scored[0] ?? null;
    // A strong match requires the best tool to hit at least half the
    // meaningful request terms (or be an exact name/technicalId match).
    const found = bestScored ? this.isStrongMatch(bestScored.tool, terms, intent) : false;

    logger.debug('[capability] discovery', { intent, terms: terms.length, found, best: best?.toolName ?? null, candidates: candidates.length });
    return { found, best, candidates, catalog: this.buildCatalog(scored.slice(0, 25).map(s => s.tool)) };
  }

  /** Strong match = exact name, or >= half the meaningful terms hit. */
  private isStrongMatch(tool: ToolDefinition, terms: string[], intent: string): boolean {
    const intentTrim = intent.trim().toLowerCase();
    if (tool.displayName.toLowerCase() === intentTrim || tool.technicalId.toLowerCase() === intentTrim) return true;
    const hay = `${tool.displayName} ${tool.description} ${tool.category} ${tool.technicalId} ${(tool.capabilities ?? []).join(' ')}`.toLowerCase();
    if (terms.length === 0) return false;
    const hits = terms.filter(t => hay.includes(t)).length;
    return hits >= Math.max(1, Math.ceil(terms.length * 0.5));
  }

  private toMatch(tool: ToolDefinition, score: number, totalTerms: number): CapabilityMatch {
    const successRate = tool.executionCount > 0 ? tool.successCount / tool.executionCount : 0;
    const avgLatency = tool.executionCount > 0 ? tool.totalExecutionTimeMs / tool.executionCount : 0;
    const confidence = Math.min(1, score / Math.max(1, totalTerms));
    return {
      toolId: tool.id,
      toolName: tool.displayName,
      description: tool.description,
      confidence: Number(confidence.toFixed(2)),
      permissions: tool.permissions,
      health: tool.health,
      latency: Math.round(avgLatency),
      successRate: Number(successRate.toFixed(2)),
      version: tool.version,
    };
  }

  private buildCatalog(tools: ToolDefinition[]): string {
    return tools
      .map(t => `${t.displayName} [${t.category}] (${t.technicalId}) — ${t.description} — runtime=${t.runtime} — health=${t.health}`)
      .join('\n');
  }

  private tokenize(intent: string): string[] {
    return intent
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(t => t.length > 2 && !GENERIC_STOPWORDS.has(t));
  }
}
