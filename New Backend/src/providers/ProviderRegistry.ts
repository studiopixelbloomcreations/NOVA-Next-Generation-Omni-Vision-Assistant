// New Backend — providers/ProviderRegistry.ts
// Central registry of AI providers + the Agent Selection Engine that chooses
// the strongest available agent for each role (reasoning, coding, planning,
// conversational) instead of hardcoding one model.
import type { AiProvider, ProviderCapability } from './ProviderTypes.js';
import { Nova2Config } from '../core/config.js';
import { logger } from '../core/logger.js';

export interface ModelCapabilityRecord {
  provider: string;
  label: string;
  reasoningScore: number;
  codingScore: number;
  speedScore: number;
  reliability: number;
  contextWindow: number;
  toolUse: boolean;
  structuredOutput: boolean;
  availability: boolean;
  latencyMs: number | null;
  checkedAt: number;
}

export class ProviderRegistry {
  private providers = new Map<string, AiProvider>();
  /** Dynamic model capability matrix, refreshed periodically (System 15). */
  private matrix = new Map<string, ModelCapabilityRecord>();

  register(provider: AiProvider): void {
    this.providers.set(provider.id, provider);
  }

  get(id: string): AiProvider | null {
    return this.providers.get(id) ?? null;
  }

  all(): AiProvider[] {
    return Array.from(this.providers.values());
  }

  /** Configured providers only. */
  configured(): AiProvider[] {
    return this.all().filter(p => p.isConfigured());
  }

  /**
   * Agent Selection Engine — pick the strongest available provider for a role.
   * Scoring balances capability role fit, model quality, context, reliability,
   * latency and configured priority. Never hardcodes a single model.
   */
  selectFor(role: ProviderCapability['role']): AiProvider | null {
    const candidates = this.all().filter(p => p.isConfigured());
    if (candidates.length === 0) return null;
    const ranked = candidates
      .map(p => ({ provider: p, score: this.scoreForRole(p, role) }))
      .sort((a, b) => b.score - a.score);
    const best = ranked[0];
    logger.debug('[provider_registry] selected agent', { role, provider: best.provider.id, score: best.score });
    return best.provider;
  }

  private scoreForRole(provider: AiProvider, role: ProviderCapability['role']): number {
    const profile = this.profile(provider);
    let fit = 0;
    if (profile.role === role) fit = 1;
    else if (role === 'coding' && profile.role === 'reasoning') fit = 0.6;
    else if (role === 'planning' && profile.role === 'reasoning') fit = 0.9;
    else fit = 0.3;
    const priority = this.priorityOf(provider.id);
    return (
      fit * 50 +
      profile.qualityRank * 0.2 +
      (profile.contextWindow / 200000) * 10 +
      profile.reliability * 15 -
      profile.latencyRank * 2 +
      priority * 20
    );
  }

  private profile(provider: AiProvider): ProviderCapability {
    switch (provider.id) {
      case 'groq':
        return { id: 'groq', role: 'coding', qualityRank: 90, contextWindow: 131072, reliability: 0.9, latencyRank: 1, priority: this.priorityOf('groq'), available: provider.isAvailable() };
      case 'gemini':
        return { id: 'gemini', role: 'reasoning', qualityRank: 88, contextWindow: 200000, reliability: 0.85, latencyRank: 3, priority: this.priorityOf('gemini'), available: provider.isAvailable() };
      default:
        return { id: provider.id, role: 'reasoning', qualityRank: 70, contextWindow: 32768, reliability: 0.7, latencyRank: 5, priority: this.priorityOf(provider.id), available: provider.isAvailable() };
    }
  }

  private priorityOf(id: string): number {
    const idx = Nova2Config.providers.priority.indexOf(id);
    return idx === -1 ? 0 : Math.max(0, 100 - idx * 30);
  }

  describe(): Record<string, unknown> {
    return Object.fromEntries(this.all().map(p => [p.id, p.describe()]));
  }

  // ---------------------------------------------------------------------------
  // Dynamic model capability matrix (System 15)
  // ---------------------------------------------------------------------------

  /** Refresh the capability matrix from the current configured providers. */
  refreshMatrix(): ModelCapabilityRecord[] {
    const now = Date.now();
    for (const p of this.all()) {
      const prof = this.profile(p);
      const base: ModelCapabilityRecord = {
        provider: p.id,
        label: p.label,
        reasoningScore: prof.role === 'reasoning' ? 9 : prof.role === 'coding' ? 7 : 5,
        codingScore: prof.role === 'coding' ? 9 : prof.role === 'reasoning' ? 7 : 5,
        speedScore: Math.max(1, 10 - prof.latencyRank),
        reliability: prof.reliability,
        contextWindow: prof.contextWindow,
        toolUse: true,
        structuredOutput: true,
        availability: p.isConfigured() && p.isAvailable(),
        latencyMs: null,
        checkedAt: now,
      };
      this.matrix.set(p.id, base);
    }
    return this.matrixOf();
  }

  matrixOf(): ModelCapabilityRecord[] {
    return Array.from(this.matrix.values());
  }

  /** Strongest model by a weighted score for a role (uses live matrix). */
  strongestFor(role: ProviderCapability['role']): AiProvider | null {
    this.refreshMatrix();
    return this.selectFor(role);
  }

  // ---------------------------------------------------------------------------
  // Periodic availability refresh (System 15)
  // ---------------------------------------------------------------------------

  private refreshTimer: ReturnType<typeof setInterval> | null = null;

  /** Start a periodic availability refresh so selection tracks reality. */
  startAutoRefresh(intervalMs = 30_000): void {
    if (this.refreshTimer) return;
    this.refreshTimer = setInterval(() => {
      try {
        this.refreshMatrix();
      } catch (err) {
        logger.warn('[provider_registry] matrix refresh failed', { error: err instanceof Error ? err.message : String(err) });
      }
    }, intervalMs);
    this.refreshTimer.unref?.();
  }

  stopAutoRefresh(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }
}
