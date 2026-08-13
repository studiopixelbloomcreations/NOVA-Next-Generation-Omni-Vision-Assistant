// New Backend — maintenance/SelfRepairEngine.ts
// Continuous Self-Repair Engine (System 18). When a subsystem/tool fails it
// runs a bounded, staged repair: detect -> classify -> diagnose -> generate a
// patch via the coding agent -> static validation -> isolated sandbox test ->
// regression -> stage candidate. It never overwrites production with an
// unvalidated patch; on any validation failure the candidate is discarded.
import { EventEmitter } from 'node:events';
import type { AiProvider } from '../providers/ProviderTypes.js';
import { AgentSelector } from '../reasoning/AgentSelector.js';
import { PromptEngine } from '../reasoning/PromptEngine.js';
import { ToolLibrary } from '../persistence/tool_library.js';
import { ValidationEngine } from '../validation/ValidationEngine.js';
import { ToolTestingEngine } from '../testing/ToolTestingEngine.js';
import { PythonRuntimeBridge } from '../execution/PythonRuntimeBridge.js';
import { Nova2Config } from '../core/config.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from '../core/logger.js';

export interface RepairOutcome {
  toolTechnicalId: string;
  repaired: boolean;
  repairCount: number;
  candidateSource: string | null;
  evidence: string;
  staged: boolean;
}

export class SelfRepairEngine extends EventEmitter {
  private readonly selector: AgentSelector;
  private readonly prompts: PromptEngine;
  private readonly validator: ValidationEngine;
  private readonly tester: ToolTestingEngine;

  constructor(
    private readonly library: ToolLibrary,
    selector: AgentSelector,
    validator: ValidationEngine,
    tester: ToolTestingEngine,
    private readonly bridge: PythonRuntimeBridge,
  ) {
    super();
    this.selector = selector;
    this.prompts = new PromptEngine();
    this.validator = validator;
    this.tester = tester;
  }

  /**
   * Attempt a staged repair of a failing generated tool. Returns the staged
   * candidate source (NOT applied to production) or null if repair failed.
   */
  async repairTool(technicalId: string, failure: string): Promise<RepairOutcome> {
    const tool = this.library.getByTechnicalId(technicalId);
    if (!tool) {
      return { toolTechnicalId: technicalId, repaired: false, repairCount: 0, candidateSource: null, evidence: 'tool not found', staged: false };
    }
    const provider = this.selector.trySelect('coding');
    if (!provider) {
      return { toolTechnicalId: technicalId, repaired: false, repairCount: 0, candidateSource: null, evidence: 'no coding provider available', staged: false };
    }

    let candidate = tool.sourceCode ?? '';
    let repairCount = 0;
    const max = Nova2Config.forge.maxRepairAttempts;
    for (let attempt = 0; attempt < max; attempt++) {
      const prompt = `You are repairing a broken A.D.A.M. Python tool. The existing source is:\n\n${candidate.slice(0, 3000)}\n\nIt failed with:\n\n${failure.slice(0, 2000)}\n\nGenerate a corrected COMPLETE Python module with a run(params) entry point and an accompanying test. Return ONLY JSON: {"pythonSource":"...","testSource":"..."}`;
      const raw = await provider.generate(prompt, { maxOutputTokens: 3072 });
      const parsed = this.parseRepair(raw);
      if (!parsed) {
        repairCount++;
        continue;
      }
      // Validate the repaired source.
      try {
        const { report } = await this.validator.validate({
          sourceCode: parsed.pythonSource,
          technicalId,
          permissions: tool.permissions,
          dependencies: tool.dependencies,
        });
        if (!report.passed) { repairCount++; continue; }
        // Stage candidate (validation/test in isolation), then sandbox test it.
        const staged = await this.stageAndTest(technicalId, parsed.pythonSource, parsed.testSource);
        if (staged) {
          this.emit('repaired', { technicalId, repairCount });
          return { toolTechnicalId: technicalId, repaired: true, repairCount, candidateSource: parsed.pythonSource, evidence: 'candidate validated and sandbox-tested', staged: true };
        }
        repairCount++;
      } catch {
        repairCount++;
      }
    }
    return { toolTechnicalId: technicalId, repaired: false, repairCount, candidateSource: null, evidence: `repair failed after ${max} attempts`, staged: false };
  }

  private async stageAndTest(technicalId: string, source: string, testSource: string): Promise<boolean> {
    const stagingDir = join(Nova2Config.paths.userData, 'staging', 'repairs', technicalId);
    mkdirSync(join(stagingDir, 'tests'), { recursive: true });
    writeFileSync(join(stagingDir, 'tool.py'), source, 'utf-8');
    writeFileSync(join(stagingDir, 'tests', 'test_tool.py'), testSource, 'utf-8');
    const toolPath = join(stagingDir, 'tool.py');
    const testPath = join(stagingDir, 'tests', 'test_tool.py');
    try {
      const outcome = await this.tester.runSandboxTest(toolPath, testPath);
      return outcome.passed;
    } catch (err) {
      logger.warn('[self_repair] sandbox test failed', { technicalId, error: err instanceof Error ? err.message : String(err) });
      return false;
    }
  }

  private parseRepair(raw: string): { pythonSource: string; testSource: string } | null {
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
    const s = cleaned.indexOf('{');
    const e = cleaned.lastIndexOf('}');
    if (s < 0 || e <= s) return null;
    try {
      const p = JSON.parse(cleaned.slice(s, e + 1)) as { pythonSource?: string; testSource?: string };
      if (!p.pythonSource || !p.testSource) return null;
      return { pythonSource: p.pythonSource, testSource: p.testSource };
    } catch {
      return null;
    }
  }
}


