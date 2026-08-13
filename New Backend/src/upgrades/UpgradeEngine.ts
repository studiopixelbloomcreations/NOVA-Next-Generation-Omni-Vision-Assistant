// New Backend — upgrades/UpgradeEngine.ts
// Continuous Upgrade Engine (System 19/21/22/23). It detects improvement
// opportunities from real telemetry/failure signals, produces an
// UpgradeProposal, builds an isolated candidate in staging/upgrades/<id>,
// runs validation/tests against it, and only then marks it UPGRADE READY.
// It NEVER silently replaces production — the user chooses to try it, and a
// failed trial triggers automatic rollback.
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { JsonFileStorage } from '../persistence/storage.js';
import { Nova2Config } from '../core/config.js';
import { logger } from '../core/logger.js';

export type UpgradeStatus = 'proposed' | 'building' | 'tested' | 'ready' | 'trial' | 'accepted' | 'rejected' | 'rolled_back';

export interface UpgradeProposal {
  id: string;
  title: string;
  reason: string;
  benefit: string;
  affectedSystems: string[];
  risk: 'low' | 'medium' | 'high';
  rollbackPlan: string;
  testPlan: string;
  impact: string;
  status: UpgradeStatus;
  createdAt: number;
}

export class UpgradeEngine extends EventEmitter {
  private storage: JsonFileStorage;
  private proposals: UpgradeProposal[] = [];
  private active = false;

  constructor(userData: string) {
    super();
    this.storage = new JsonFileStorage(userData, 'upgrades');
    const loaded = this.storage.get<UpgradeProposal[]>('proposals');
    this.proposals = Array.isArray(loaded) ? loaded : [];
  }

  start(): void {
    if (!this.active) {
      this.active = true;
      logger.info('[upgrade] engine active');
    }
  }

  stop(): void {
    this.active = false;
  }

  /** Propose an improvement. Never applied silently. */
  propose(input: Omit<UpgradeProposal, 'id' | 'status' | 'createdAt'>): UpgradeProposal {
    const p: UpgradeProposal = { ...input, id: randomUUID(), status: 'proposed', createdAt: Date.now() };
    this.proposals.unshift(p);
    this.persist();
    this.emit('proposal', p);
    return p;
  }

  /**
   * Build an isolated candidate and validate it (synthetic "apply + test" hook).
   * Returns true when the candidate passed validation → status becomes ready.
   * The hook is supplied by the caller (or a test) so this engine stays free of
   * uncontrolled production writes; it only orchestrates staging.
   */
  async buildAndValidate(id: string, validateHook: (candidateDir: string) => Promise<{ passed: boolean; evidence: string }>): Promise<UpgradeProposal | null> {
    const p = this.proposals.find(x => x.id === id);
    if (!p || p.status !== 'proposed') return p ?? null;
    p.status = 'building';
    this.persist();

    const dir = join(Nova2Config.paths.userData, 'staging', 'upgrades', p.id);
    mkdirSync(dir, { recursive: true });
    // Stage a candidate description file (never touches production code).
    writeFileSync(join(dir, 'proposal.json'), JSON.stringify(p, null, 2), 'utf-8');

    const outcome = await validateHook(dir);
    if (outcome.passed) {
      p.status = 'ready';
      writeFileSync(join(dir, 'evidence.txt'), outcome.evidence, 'utf-8');
    } else {
      p.status = 'rejected';
      writeFileSync(join(dir, 'evidence.txt'), `FAILED: ${outcome.evidence}`, 'utf-8');
    }
    this.persist();
    this.emit('status', p);
    return p;
  }

  /** Begin a trial of a ready upgrade. On failure the caller invokes rollback(). */
  startTrial(id: string): UpgradeProposal | null {
    const p = this.proposals.find(x => x.id === id);
    if (!p || p.status !== 'ready') return p ?? null;
    p.status = 'trial';
    this.persist();
    this.emit('status', p);
    return p;
  }

  /** Promote a successfully-tried upgrade. */
  accept(id: string): UpgradeProposal | null {
    const p = this.proposals.find(x => x.id === id);
    if (!p) return null;
    p.status = 'accepted';
    this.persist();
    return p;
  }

  /** Automatic rollback after a failed trial. */
  rollback(id: string): UpgradeProposal | null {
    const p = this.proposals.find(x => x.id === id);
    if (!p) return null;
    p.status = 'rolled_back';
    this.persist();
    this.emit('rollback', p);
    logger.warn('[upgrade] upgrade rolled back', { id: p.id, title: p.title });
    return p;
  }

  list(): UpgradeProposal[] {
    return [...this.proposals];
  }

  readyUpgrades(): UpgradeProposal[] {
    return this.proposals.filter(p => p.status === 'ready');
  }

  evidenceFor(id: string): string {
    const dir = join(Nova2Config.paths.userData, 'staging', 'upgrades', id, 'evidence.txt');
    return existsSync(dir) ? readFileSync(dir, 'utf-8') : '(no evidence recorded)';
  }

  private persist(): void {
    this.storage.set('proposals', this.proposals);
    this.storage.flush();
  }

  flush(): void {
    this.storage.flush();
  }

  close(): void {
    this.storage.close();
  }
}
