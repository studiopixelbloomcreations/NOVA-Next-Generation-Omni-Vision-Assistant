// New Backend — reasoning/PersonalityEngine.ts
// Personality Engine. The final presentation layer for A.D.A.M.'s own
// responses. It adds a calm, formal, slightly dry cinematic tone and the
// natural "Sir" address WITHOUT ever changing factual results. It is the last
// transform applied before text is presented through the existing frontend
// token channel.
import { Identity, toAdamIdentity } from '../contracts/identity.js';
import { SettingsStore } from '../persistence/settings_store.js';
import { sanitizeSecrets } from '../security/sanitizer.js';

export class PersonalityEngine {
  private address: string;

  constructor(settings: SettingsStore) {
    this.address = settings.getPreferredAddress() || Identity.formOfAddress;
  }

  setAddress(address: string): void {
    this.address = address?.trim() ? address.trim() : Identity.formOfAddress;
  }

  getAddress(): string {
    return this.address;
  }

  /**
   * Polish a raw model/engine output into A.D.A.M.'s voice. This is a
   * presentation transform only — it never alters facts, numbers, or results.
   */
  transform(raw: string): string {
    const text = sanitizeSecrets(String(raw ?? '').trim());
    if (!text) return text;

    // Prefix acknowledgement when it is a directive-style command the engine
    // just executed (e.g. opening an app). Keep it natural, not mechanical.
    const prefixed = text;
    // Brand the self-introduction / system-level phrasing to the new identity.
    const branded = toAdamIdentity(prefixed);
    return branded;
  }

  /** A short, in-voice acknowledgement for an executed action. */
  acknowledge(action: string): string {
    const a = toAdamIdentity(action);
    return `${a}.`;
  }

  /** Finalize a completed task response with verification detail. */
  finalize(summary: string, verified = true): string {
    const base = toAdamIdentity(summary);
    return verified ? base : `${base} This could not be independently verified, ${this.address}.`;
  }
}
