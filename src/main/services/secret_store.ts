// src/main/services/secret_store.ts
// Secure storage for API keys and other secrets.
//
// Uses Electron's safeStorage (OS-level encryption: DPAPI on Windows, Keychain
// on macOS, libsecret on Linux) to persist secrets at rest. Environment
// variables bootstrap the vault on first run; the vault never writes secrets
// back to disk in plaintext.
import * as fs from 'fs';
import * as path from 'path';
import { safeStorage } from 'electron';
import { logger } from '../core/logger';

interface VaultPayload {
  version: 1;
  entries: Record<string, string>;
}

export class SecretStore {
  private vaultPath: string;
  private entries: Record<string, string> = {};

  constructor(vaultPath: string) {
    this.vaultPath = vaultPath;
    this.load();
  }

  private load(): void {
    try {
      if (!fs.existsSync(this.vaultPath)) return;
      if (!safeStorage.isEncryptionAvailable()) {
        logger.warn('[secret_store] safeStorage encryption unavailable; skipping vault load');
        return;
      }
      const raw = fs.readFileSync(this.vaultPath);
      const decrypted = safeStorage.decryptString(raw);
      const payload = JSON.parse(decrypted) as VaultPayload;
      this.entries = payload.entries ?? {};
      logger.debug('[secret_store] vault loaded', { keys: Object.keys(this.entries) });
    } catch (err) {
      // Corrupt or undecryptable vault — start empty rather than crash.
      logger.error('[secret_store] failed to load vault; starting empty', {
        error: err instanceof Error ? err.message : String(err),
      });
      this.entries = {};
    }
  }

  private persist(): void {
    try {
      fs.mkdirSync(path.dirname(this.vaultPath), { recursive: true });
      if (!safeStorage.isEncryptionAvailable()) {
        logger.warn('[secret_store] safeStorage unavailable; secret NOT persisted');
        return;
      }
      const payload: VaultPayload = { version: 1, entries: this.entries };
      const encrypted = safeStorage.encryptString(JSON.stringify(payload));
      fs.writeFileSync(this.vaultPath, encrypted, { mode: 0o600 });
    } catch (err) {
      logger.error('[secret_store] failed to persist vault', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Resolves a secret: env var first (runtime override), then the vault.
   * When `bootstrapFromEnv` is set and only the env value exists, it is
   * captured into the vault.
   */
  public get(name: string, bootstrapFromEnv = true): string {
    const envValue = process.env[name];
    if (envValue && envValue.trim() !== '') {
      if (bootstrapFromEnv && !this.entries[name]) {
        this.set(name, envValue);
      }
      return envValue;
    }
    return this.entries[name] ?? '';
  }

  public set(name: string, value: string): void {
    if (!value) {
      delete this.entries[name];
    } else {
      this.entries[name] = value;
    }
    this.persist();
  }

  public has(name: string): boolean {
    return this.get(name, false) !== '';
  }

  public list(): string[] {
    return Object.keys(this.entries);
  }
}
