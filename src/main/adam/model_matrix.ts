// A.D.A.M. — additive model capability matrix + role-based agent selection.
// Merged into the restored legacy backend as an ADDITIVE capability. Scores
// providers by role fit, quality, context, reliability, latency and priority,
// and selects the strongest available model for a task — never hardcodes one.
import type { AiProvider, AiProviderRegistry } from '../services/ai_provider';

export type AgentRole = 'reasoning' | 'coding' | 'planning' | 'conversational';

export interface ModelCapabilityRecord {
  provider: string;
  label: string;
  reasoningScore: number;
  codingScore: number;
  speedScore: number;
  reliability: number;
  contextWindow: number;
  availability: boolean;
}

export class AdamModelMatrix {
  constructor(private readonly registry: AiProviderRegistry) {}

  /** Select the strongest available provider for a role. */
  selectFor(role: AgentRole): AiProvider | null {
    const candidates = this.registry.all().filter(p => p.isConfigured());
    if (candidates.length === 0) return null;
    const ranked = candidates
      .map(p => ({ provider: p, score: this.scoreForRole(p, role) }))
      .sort((a, b) => b.score - a.score);
    return ranked[0]?.provider ?? null;
  }

  private scoreForRole(p: AiProvider, role: AgentRole): number {
    const prof = this.profile(p);
    let fit = 0;
    if (role === 'coding' && p.id === 'groq') fit = 1;
    else if (role === 'reasoning' && (p.id === 'groq' || p.id === 'gemini')) fit = 0.9;
    else if (role === 'planning' && p.id === 'groq') fit = 0.9;
    else fit = 0.4;
    return (
      fit * 50 +
      (prof.reasoningScore + prof.codingScore) * 0.2 +
      prof.speedScore * 3 +
      prof.reliability * 15 +
      (prof.contextWindow / 200000) * 10
    );
  }

  private profile(p: AiProvider): ModelCapabilityRecord {
    switch (p.id) {
      case 'groq':
        return { provider: p.id, label: p.label, reasoningScore: 9, codingScore: 9, speedScore: 9, reliability: 0.9, contextWindow: 131072, availability: p.isConfigured() };
      case 'gemini':
        return { provider: p.id, label: p.label, reasoningScore: 9, codingScore: 8, speedScore: 6, reliability: 0.85, contextWindow: 200000, availability: p.isConfigured() };
      default:
        return { provider: p.id, label: p.label, reasoningScore: 6, codingScore: 6, speedScore: 5, reliability: 0.7, contextWindow: 32768, availability: p.isConfigured() };
    }
  }

  matrix(): ModelCapabilityRecord[] {
    return this.registry.all().map(p => this.profile(p));
  }
}
