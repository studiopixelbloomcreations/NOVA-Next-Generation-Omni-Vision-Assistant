// New Backend — providers/ProviderTypes.ts
// Provider-agnostic AI interface. Providers are raw model clients only; all
// prompt construction lives in the Prompt Engine and all planning in the
// Planning Engine. A.D.A.M. Core is the execution authority — providers never
// directly own physical actions.
export interface GenerateOptions {
  timeoutMs?: number;
  maxOutputTokens?: number;
  temperature?: number;
}

export interface AiProvider {
  readonly id: string;
  readonly label: string;
  isConfigured(): boolean;
  isAvailable(): boolean;
  generate(prompt: string, opts?: GenerateOptions): Promise<string>;
  describe(): Record<string, unknown>;
}

/** Model capability profile used by the Agent Selection Engine. */
export interface ProviderCapability {
  id: string;
  /** Role this provider is strongest at. */
  role: 'reasoning' | 'coding' | 'conversational' | 'planning';
  qualityRank: number;
  contextWindow: number;
  reliability: number; // 0..1
  latencyRank: number; // lower is faster
  priority: number; // configured priority
  available: boolean;
}

export class ProviderNotFoundError extends Error {
  constructor(role: string) {
    super(`No configured provider can fulfill role: ${role}`);
    this.name = 'ProviderNotFoundError';
  }
}
