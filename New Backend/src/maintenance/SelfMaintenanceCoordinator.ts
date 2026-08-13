// New Backend — maintenance/SelfMaintenanceCoordinator.ts
// Closes the self-management loop (Systems 18/23/45). When the Maintenance
// Engine raises a finding for a broken/degraded generated tool, this
// coordinator dispatches a diagnostic, selects a coding agent, generates a
// patch, validates + sandbox-tests it, and promotes it to a STAGED candidate.
// It never overwrites production with an unvalidated patch; if validation
// fails the candidate is discarded and the tool stays inactive.
import { EventEmitter } from 'node:events';
import type { MaintenanceFinding } from './MaintenanceEngine.js';
import { SelfRepairEngine, type RepairOutcome } from './SelfRepairEngine.js';
import { ToolLibrary } from '../persistence/tool_library.js';
import { logger } from '../core/logger.js';

export interface RepairDecision {
  finding: MaintenanceFinding;
  outcome: RepairOutcome | null;
  staged: boolean;
  note: string;
}

export class SelfMaintenanceCoordinator extends EventEmitter {
  private inFlight = new Set<string>();

  constructor(private readonly library: ToolLibrary, private readonly repair: SelfRepairEngine) {
    super();
  }

  /**
   * Handle a maintenance finding autonomously. Only tool-repair findings are
   * auto-acted upon here (harmless, bounded, staged). Other findings are logged
   * and surfaced but not auto-modified.
   */
  async handleFinding(finding: MaintenanceFinding): Promise<RepairDecision> {
    // Only act on tool health findings; everything else is observed/reported.
    if (!finding.subsystem.startsWith('tool:')) {
      return { finding, outcome: null, staged: false, note: 'observation-only finding' };
    }
    const technicalId = finding.subsystem.slice('tool:'.length);
    if (this.inFlight.has(technicalId)) {
      return { finding, outcome: null, staged: false, note: 'repair already in flight' };
    }
    this.inFlight.add(technicalId);
    try {
      const outcome = await this.repair.repairTool(technicalId, finding.detail);
      const staged = outcome.repaired && outcome.staged;
      if (staged) {
        this.emit('repair-staged', outcome);
        logger.info('[self_maintenance] staged repair candidate', { technicalId, repairCount: outcome.repairCount });
      } else {
        logger.warn('[self_maintenance] repair did not produce a validated candidate', { technicalId, evidence: outcome.evidence });
      }
      return { finding, outcome, staged, note: staged ? 'candidate staged' : 'no validated candidate' };
    } finally {
      this.inFlight.delete(technicalId);
    }
  }
}
