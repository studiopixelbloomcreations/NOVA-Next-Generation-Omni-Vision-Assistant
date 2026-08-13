// New Backend — reasoning/OutputEngine.ts
// Output Engine (System 48). Composes the final user-facing response from the
// execution trace: what was requested, what was done, what was verified, the
// important result, and any relevant recovery/failure. The result is the single
// coherent response the user experiences from A.D.A.M.
import type { ExecutionLedgerEntry } from '../contracts/domain.js';
import { PersonalityEngine } from './PersonalityEngine.js';

export class OutputEngine {
  constructor(private readonly personality: PersonalityEngine) {}

  /** Compose a coherent final response from a ledger entry. */
  compose(entry: ExecutionLedgerEntry): string {
    const verifiedSteps = entry.steps.filter(s => s.success && s.verification.passed).length;

    if (entry.status === 'completed' && verifiedSteps > 0) {
      const parts: string[] = [];
      // Important result: surface the final payload if it is meaningful.
      const lastVerified = entry.steps[entry.steps.length - 1];
      const result = this.describeResult(lastVerified?.payload);
      parts.push(
        `Completed — ${verifiedSteps} verified step${verifiedSteps === 1 ? '' : 's'}.`,
      );
      if (result) parts.push(result);
      if (entry.retries > 0) parts.push(`(Recovered after ${entry.retries} retr${entry.retries === 1 ? 'y' : 'ies'}.)`);
      return this.personality.finalize(parts.join(' '), true);
    }
    if (entry.status === 'partial') {
      return this.personality.finalize(
        `Partially completed — ${verifiedSteps} step${verifiedSteps === 1 ? '' : 's'} verified, but not all steps could be completed.`,
        true,
      );
    }
    const lastError = entry.errors[entry.errors.length - 1];
    const reason = lastError ? ` Reason: ${lastError.slice(0, 200)}.` : '';
    return this.personality.finalize(
      `I was unable to complete the objective after exhausting my available strategies.${reason}`,
      false,
    );
  }

  private describeResult(payload: unknown): string | null {
    if (payload === null || payload === undefined) return null;
    if (typeof payload === 'object') {
      const p = payload as Record<string, unknown>;
      if (p.success === false) return null;
      // Files / surfaces / reports are the most useful to surface.
      if (typeof p.largestFile === 'object' && p.largestFile) {
        const lf = p.largestFile as Record<string, unknown>;
        return `Largest file: "${lf.name}" (${lf.sizeBytes} bytes).`;
      }
      if (typeof p.fileCount === 'number') return `Analysed ${p.fileCount} file${p.fileCount === 1 ? '' : 's'}.`;
      if (typeof p.title === 'string' && typeof p.content === 'string') {
        return p.content ? `Presented: ${p.title}.` : `Presented ${p.title}.`;
      }
    }
    if (typeof payload === 'string' && payload.length) return payload.slice(0, 200);
    if (typeof payload === 'number') return String(payload);
    return null;
  }
}
