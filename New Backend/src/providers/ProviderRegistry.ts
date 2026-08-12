// New Backend — providers/ProviderRegistry.ts
// Central registry of AI providers + the Agent Selection Engine that chooses
// the strongest available agent for each role (reasoning, coding, planning,
// conversational) instead of hardcoding one model.
import type { AiProvider, ProviderCapability } from './ProviderTypes.js';
import { Nova2Config } from '../core/config.js';
import { logger } from '../core/logger.js';

export class ProviderRegistry {
  private providers = new Map<string, AiProvider>();

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
}
