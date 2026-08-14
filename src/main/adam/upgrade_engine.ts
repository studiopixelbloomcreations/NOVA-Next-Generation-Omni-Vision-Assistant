// A.D.A.M. — additive Continuous Upgrade Engine.
// Merged into the restored legacy backend as an ADDITIVE capability. Produces
// UpgradeProposal, builds an isolated candidate in staging/upgrades/<id>,
// validates it, and only marks it UPGRADE READY. NEVER silently replaces
// production — the user chooses to try it, and a failed trial rolls back.
import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';

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

export class AdamUpgradeEngine extends EventEmitter {
  private proposals: UpgradeProposal[] = [];
  private active = false;

  constructor(private readonly userData: string) {
    super();
  }

  start(): void { this.active = true; }
  stop(): void { this.active = false; }
  isActive(): boolean { return this.active; }

  propose(input: Omit<UpgradeProposal, 'id' | 'status' | 'createdAt'>): UpgradeProposal {
    const p: UpgradeProposal = { ...input, id: randomUUID(), status: 'proposed', createdAt: Date.now() };
    this.proposals.unshift(p);
    this.emit('proposal', p);
    return p;
  }

  /** Build an isolated candidate and validate it via the supplied hook. */
  async buildAndValidate(id: string, validateHook: (candidateDir: string) => Promise<{ passed: boolean; evidence: string }>): Promise<UpgradeProposal | null> {
    const p = this.proposals.find(x => x.id === id);
    if (!p || p.status !== 'proposed') return p ?? null;
    p.status = 'building';
    const dir = join(this.userData, 'staging', 'upgrades', p.id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'proposal.json'), JSON.stringify(p, null, 2), 'utf-8');
    const outcome = await validateHook(dir);
    p.status = outcome.passed ? 'ready' : 'rejected';
    writeFileSync(join(dir, 'evidence.txt'), `${outcome.passed ? 'PASSED' : 'FAILED'}: ${outcome.evidence}`, 'utf-8');
    this.emit('status', p);
    return p;
  }

  startTrial(id: string): UpgradeProposal | null {
    const p = this.proposals.find(x => x.id === id);
    if (!p || p.status !== 'ready') return p ?? null;
    p.status = 'trial';
    this.emit('status', p);
    return p;
  }

  accept(id: string): UpgradeProposal | null {
    const p = this.proposals.find(x => x.id === id);
    if (!p) return null;
    p.status = 'accepted';
    return p;
  }

  rollback(id: string): UpgradeProposal | null {
    const p = this.proposals.find(x => x.id === id);
    if (!p) return null;
    p.status = 'rolled_back';
    this.emit('rollback', p);
    return p;
  }

  list(): UpgradeProposal[] { return [...this.proposals]; }
  readyUpgrades(): UpgradeProposal[] { return this.proposals.filter(p => p.status === 'ready'); }

  evidenceFor(id: string): string {
    const dir = join(this.userData, 'staging', 'upgrades', id, 'evidence.txt');
    return existsSync(dir) ? readFileSync(dir, 'utf-8') : '(no evidence recorded)';
  }
}
