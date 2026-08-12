// New Backend — reasoning/AgentSelector.ts
// Agent Selection Engine. Selects the strongest available reasoning/coding
// agent for each task, with an explicit interface the orchestrator calls.
import type { AiProvider, ProviderCapability } from '../providers/ProviderTypes.js';
import { ProviderRegistry } from '../providers/ProviderRegistry.js';
import { ProviderUnavailableError } from '../core/errors.js';

export type AgentRole = ProviderCapability['role'];

export class AgentSelector {
  constructor(private readonly registry: ProviderRegistry) {}

  /**
   * Strongest available agent for a role. Throws ProviderUnavailableError when
   * nothing is configured — NOVA must never silently use the wrong model.
   */
  select(role: AgentRole): AiProvider {
    const provider = this.registry.selectFor(role);
    if (!provider) {
      throw new ProviderUnavailableError(
        `No AI provider is configured for the '${role}' role. Add a GROQ_API_KEY or GEMINI_API_KEY to the NOVA Secrets vault (or environment).`,
      );
    }
    return provider;
  }

  /** Nullable variant used for graceful degradation in the forge/tests. */
  trySelect(role: AgentRole): AiProvider | null {
    return this.registry.selectFor(role);
  }
}
