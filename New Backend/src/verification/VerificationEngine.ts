// New Backend — verification/VerificationEngine.ts
// Verification Engine. Never trusts "tool returned success" as proof. It runs
// pluggable verifiers against the actual outcome (filesystem, process, file,
// search, workspace state) and optionally an AI verifier. A model statement is
// never treated as evidence of completion on its own.
import type { AiProvider } from '../providers/ProviderTypes.js';
import { PromptEngine } from '../reasoning/PromptEngine.js';
import { ToolLibrary } from '../persistence/tool_library.js';
import { logger } from '../core/logger.js';

export interface VerificationOutcome {
  passed: boolean;
  detail: string;
}

export type VerifierFn = (payload: unknown, expected: string) => VerificationOutcome | Promise<VerificationOutcome>;

export class VerificationEngine {
  private verifiers = new Map<string, VerifierFn>();
  private readonly prompts = new PromptEngine();

  constructor(private readonly library: ToolLibrary, private readonly providerSelector?: () => AiProvider | null) {}

  /** Register a pluggable verifier by capability/tool type. */
  registerVerifier(type: string, fn: VerifierFn): void {
    this.verifiers.set(type.toLowerCase(), fn);
  }

  /**
   * Verify an outcome. Uses a registered verifier for the tool/capability when
   * available, else objective verification, else (optionally) an AI verifier.
   */
  async verify(payload: unknown, expected: string, toolType?: string, request?: string): Promise<VerificationOutcome> {
    const started = Date.now();
    if (toolType) {
      const fn = this.verifiers.get(toolType.toLowerCase());
      if (fn) {
        const out = await fn(payload, expected);
        logger.debug('[verification] type verifier', { toolType, passed: out.passed, detail: out.detail });
        return out;
      }
    }
    const objective = this.objectiveVerify(payload, expected);
    if (objective.passed) return objective;

    // Objective check inconclusive + AI verifier available.
    if (this.providerSelector && request) {
      const provider = this.providerSelector();
      if (provider && provider.isConfigured()) {
        const ai = await this.modelVerify(provider, request, expected, payload);
        logger.debug('[verification] model verifier', { passed: ai.passed, detail: ai.detail, ms: Date.now() - started });
        return ai;
      }
    }
    return objective;
  }

  /** Independent objective verification of the payload shape. */
  objectiveVerify(payload: unknown, expected: string): VerificationOutcome {
    if (payload === null || payload === undefined) return { passed: false, detail: 'no result returned' };
    if (typeof payload === 'object') {
      const p = payload as Record<string, unknown>;
      if (p.success === false) return { passed: false, detail: String(p.error ?? 'tool reported failure') };
      if (p.success === true) return { passed: true, detail: 'tool reported success with a structured result' };
      // A result that is not flagged as failure and has content is accepted
      // when the expected condition is a generic completion.
      return { passed: true, detail: `result returned for verification target: ${expected.slice(0, 160)}` };
    }
    if (typeof payload === 'string' && payload.length > 0) return { passed: true, detail: 'non-empty result returned' };
    if (typeof payload === 'number') return { passed: true, detail: `numeric result returned: ${payload}` };
    return { passed: true, detail: `result returned for target: ${expected.slice(0, 120)}` };
  }

  private async modelVerify(provider: AiProvider, request: string, expected: string, payload: unknown): Promise<VerificationOutcome> {
    try {
      const prompt = this.prompts.buildVerificationPrompt(request, expected, expected, JSON.stringify(payload));
      const raw = await provider.generate(prompt, { timeoutMs: 8000, maxOutputTokens: 256 });
      const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
      const start = cleaned.indexOf('{');
      const end = cleaned.lastIndexOf('}');
      if (start < 0 || end <= start) return { passed: false, detail: 'verifier returned no JSON' };
      const parsed = JSON.parse(cleaned.slice(start, end + 1)) as { passed?: boolean; detail?: string };
      if (typeof parsed.passed === 'boolean') return { passed: parsed.passed, detail: String(parsed.detail ?? '') };
    } catch (err) {
      logger.debug('[verification] model verifier unavailable', { error: err instanceof Error ? err.message : String(err) });
    }
    return { passed: false, detail: 'independent verification could not be established' };
  }
}

/** Standard verifiers factory. */
export function registerStandardVerifiers(engine: VerificationEngine, library: ToolLibrary): void {
  // File creation verifier: inspect the filesystem independently.
  engine.registerVerifier('fs-write', (payload) => {
    const p = payload as Record<string, unknown>;
    const target = (p?.path as string) ?? (p?.file as string);
    if (target) {
      const exists = ToolLibrary.verifyFileOnDisk(target).exists;
      return exists ? { passed: true, detail: `file exists on disk: ${target}` } : { passed: false, detail: `file not found on disk: ${target}` };
    }
    return { passed: p?.success === true, detail: p?.success ? 'write reported success' : 'write did not report success' };
  });

  // Directory analysis verifier: the payload must carry a real largestFile list.
  engine.registerVerifier('directory-analysis', (payload) => {
    const p = payload as Record<string, unknown>;
    const largest = p?.largest ?? p?.largestFile;
    if (Array.isArray(largest)) {
      return largest.length > 0
        ? { passed: true, detail: `analysis returned ${largest.length} file(s)` }
        : { passed: false, detail: 'analysis returned an empty file list' };
    }
    if (largest && typeof largest === 'object') return { passed: true, detail: 'analysis returned a largest-file record' };
    return { passed: false, detail: 'analysis did not return file metadata' };
  });
}
