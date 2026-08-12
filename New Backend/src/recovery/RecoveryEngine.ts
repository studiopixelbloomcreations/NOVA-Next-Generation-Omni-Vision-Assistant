// New Backend — recovery/RecoveryEngine.ts
// Recovery Engine. Classifies a failure and selects the next recovery action.
// It never repeats the same failed action indefinitely; it escalates through
// retry -> alternative strategy -> alternative tool -> repair/create tool ->
// replan, bounded by the configured attempt ceiling.
import { classifyFailure } from '../core/errors.js';
import type { FailureClass, FailureReport, RecoveryDecision } from '../contracts/domain.js';
import { Nova2Config } from '../core/config.js';
import { logger } from '../core/logger.js';

export class RecoveryEngine {
  /** Decide the recovery action for a failed step. */
  decide(report: FailureReport): RecoveryDecision {
    const attempts = report.attempts;
    const max = Nova2Config.execution.maxRetriesPerStep;

    // Escalation ladder based on failure class.
    switch (report.class) {
      case 'timeout':
      case 'network_failure':
        // Transient: retry a couple times, then restart worker.
        if (attempts < 2) return { action: 'retry', rationale: `transient ${report.class}; retrying` };
        if (attempts < 3) return { action: 'restart_worker', rationale: 'transient failure persisted; restarting worker' };
        return { action: 'alternative_strategy', rationale: 'transient failure exhausted; trying an alternative strategy' };

      case 'tool_error':
      case 'dependency_error':
        if (attempts === 1) return { action: 'retry', rationale: 'tool error on first attempt; retrying' };
        if (attempts === 2) return { action: 'repair_tool', rationale: 'tool error persisted; repairing the tool' };
        return { action: 'create_tool', rationale: 'tool cannot be repaired; forging a fresh capability' };

      case 'permission':
      case 'malformed_output':
        return { action: 'alternative_strategy', rationale: `hard ${report.class}; switching strategy` };

      case 'verification_failure':
        if (attempts === 1) return { action: 'retry', rationale: 'verification failed on first attempt; retrying' };
        return { action: 'alternative_strategy', rationale: 'verification failed again; trying another approach' };

      case 'environment_mismatch':
      case 'application_failure':
        return { action: 'replan', rationale: `${report.class}; requires a new plan` };

      case 'provider_unavailable':
        return { action: 'replan', rationale: 'no provider available; returning an honest failure' };

      default:
        return attempts < max ? { action: 'retry', rationale: 'retrying within bound' } : { action: 'replan', rationale: 'attempts exhausted; replanning' };
    }
  }

  /** Convenience: classify an arbitrary thrown value into a FailureReport. */
  toReport(err: unknown, attempts: number): FailureReport {
    const cls = classifyFailure(err);
    const message = err instanceof Error ? err.message : String(err);
    return { class: cls, message, attempts };
  }

  /** Whether NOVA should give up entirely after this report (bounds). */
  exhausted(report: FailureReport): boolean {
    return report.attempts >= Nova2Config.execution.maxRetriesPerStep + 1;
  }

  log(report: FailureReport, decision: RecoveryDecision): void {
    logger.warn('[recovery] failure handled', { class: report.class, action: decision.action, attempts: report.attempts, message: report.message.slice(0, 200) });
  }
}
