// New Backend — security/secret_store.ts
// Encrypted vault for API keys/tokens. Values are encrypted at rest with
// AES-256-GCM under a key derived from a per-machine secret + a random salt.
// Secrets are served only to the ProviderRegistry — never to memory, tool
// prompts, or subprocesses.
import { randomBytes, createCipheriv, createDecipheriv, createHash, scryptSync } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { logger } from '../core/logger.js';

const ALGO = 'aes-256-gcm';

export class SecretStore {
  private readonly filePath: string;
  private cache = new Map<string, string>();

  constructor(filePath: string) {
    this.filePath = filePath;
    this.load();
  }

  private masterKey(): Buffer {
    const machine = (process.env.NOVA2_VAULT_KEY ?? process.env.USERNAME ?? process.env.USER ?? 'nova-local').toString();
    // Derive a stable 32-byte key from machine context + salt persisted on disk.
    const saltPath = `${this.filePath}.salt`;
    let salt: Buffer;
    if (existsSync(saltPath)) {
      salt = Buffer.from(readFileSync(saltPath, 'utf-8'), 'hex');
    } else {
      salt = randomBytes(16);
      mkdirSync(dirname(this.filePath), { recursive: true });
      writeFileSync(saltPath, salt.toString('hex'), 'utf-8');
    }
    return scryptSync(machine, salt, 32);
  }

  private load(): void {
    if (!existsSync(this.filePath)) return;
    try {
      const key = this.masterKey();
      const obj = JSON.parse(readFileSync(this.filePath, 'utf-8')) as Record<string, string>;
      for (const [k, blob] of Object.entries(obj)) {
        this.cache.set(k, this.decrypt(blob, key));
      }
    } catch (err) {
      logger.warn('[secret_store] failed to decrypt vault', { error: err instanceof Error ? err.message : String(err) });
    }
  }

  private encrypt(plain: string, key: Buffer): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv(ALGO, key, iv);
    const enc = Buffer.concat([cipher.update(plain, 'utf-8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, enc]).toString('base64');
  }

  private decrypt(blob: string, key: Buffer): string {
    const raw = Buffer.from(blob, 'base64');
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(12, 28);
    const data = raw.subarray(28);
    const decipher = createDecipheriv(ALGO, key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf-8');
  }

  get(name: string): string | null {
    return this.cache.get(name) ?? process.env[name] ?? null;
  }

  set(name: string, value: string): void {
    this.cache.set(name, value);
    this.persist();
  }

  has(name: string): boolean {
    return Boolean(this.get(name));
  }

  private persist(): void {
    const key = this.masterKey();
    const obj: Record<string, string> = {};
    for (const [k, v] of this.cache) obj[k] = this.encrypt(v, key);
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(obj, null, 2), 'utf-8');
  }
}
