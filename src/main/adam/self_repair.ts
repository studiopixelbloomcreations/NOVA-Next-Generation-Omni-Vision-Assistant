// A.D.A.M. — additive Self-Repair Engine (staged, validated).
// Merged into the restored legacy backend as an ADDITIVE capability. When a
// generated tool fails, it generates a corrected patch via the coding agent,
// validates it, and stages it in staging/repairs/<technicalId>. It NEVER
// overwrites production with an unvalidated patch.
import { EventEmitter } from 'events';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { AiProviderRegistry } from '../services/ai_provider';
import type { ToolRegistry } from '../services/tool_registry';
import { toolValidator } from '../services/tool_validator';

export interface RepairOutcome {
  technicalId: string;
  repaired: boolean;
  repairCount: number;
  candidateSource: string | null;
  evidence: string;
  staged: boolean;
}

export class AdamSelfRepairEngine extends EventEmitter {
  constructor(
    private readonly registry: ToolRegistry,
    private readonly providers: AiProviderRegistry,
    private readonly userData: string,
    private readonly maxRepairAttempts = 3,
  ) {
    super();
  }

  async repairTool(technicalId: string, failure: string): Promise<RepairOutcome> {
    const tool = this.registry.list().find(t => t.technicalId === technicalId) ?? this.registry.list().find(t => t.name === technicalId);
    if (!tool) {
      return { technicalId, repaired: false, repairCount: 0, candidateSource: null, evidence: 'tool not found', staged: false };
    }
    const codingAgent = this.providers.get('groq')?.isConfigured() ? this.providers.get('groq')! : this.providers.primary();
    if (!codingAgent || !codingAgent.isConfigured()) {
      return { technicalId, repaired: false, repairCount: 0, candidateSource: null, evidence: 'no coding provider available', staged: false };
    }

    const source = tool.sourceCode || '';
    let repairCount = 0;
    for (let attempt = 0; attempt < this.maxRepairAttempts; attempt++) {
      try {
        const prompt =
          `You are repairing a broken A.D.A.M. Python tool. The existing source is:\n\n${source.slice(0, 3000)}\n\n` +
          `It failed with:\n\n${failure.slice(0, 2000)}\n\n` +
          `Generate a corrected COMPLETE Python module with a run(params) entry point. Return ONLY JSON: {"pythonSource":"..."}`;
        const raw = await codingAgent.generate(prompt, { maxOutputTokens: 3072 });
        const parsed = this.parseRepair(raw);
        if (!parsed) { repairCount++; continue; }

        // Validate the repaired source via the legacy tool validator.
        const report = await toolValidator.validate({
          sourceCode: parsed.pythonSource,
          assertions: [
            { description: 'must not throw on default context', context: {}, mustNotThrow: true },
            { description: 'must return an object', mustBeObject: true },
            { description: 'must include success flag', mustHaveKey: 'success' },
          ],
        });
        if (!report.passed) { repairCount++; continue; }

        // Stage candidate (never applied to production).
        const dir = join(this.userData, 'staging', 'repairs', technicalId);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'tool.py'), parsed.pythonSource, 'utf-8');
        this.emit('repaired', { technicalId, repairCount });
        return { technicalId, repaired: true, repairCount, candidateSource: parsed.pythonSource, evidence: 'candidate validated and staged', staged: true };
      } catch {
        repairCount++;
      }
    }
    return { technicalId, repaired: false, repairCount, candidateSource: null, evidence: `repair failed after ${this.maxRepairAttempts} attempts`, staged: false };
  }

  private parseRepair(raw: string): { pythonSource: string } | null {
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
    const s = cleaned.indexOf('{');
    const e = cleaned.lastIndexOf('}');
    if (s < 0 || e <= s) return null;
    try {
      const p = JSON.parse(cleaned.slice(s, e + 1)) as { pythonSource?: string };
      if (!p.pythonSource) return null;
      return { pythonSource: p.pythonSource };
    } catch {
      return null;
    }
  }
}
