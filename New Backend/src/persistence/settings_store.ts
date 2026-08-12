// New Backend — persistence/settings_store.ts
// Persistent settings/identity/preferences (non-secret). Secrets never live
// here — they go through the SecretStore.
import { JsonFileStorage } from './storage.js';

export interface NovaSettings {
  identity?: { preferredAddress?: string; userHandle?: string };
  preferences?: Record<string, unknown>;
  workspace?: { restoredSurfaces?: boolean };
  formOfAddress?: string;
}

export class SettingsStore {
  private storage: JsonFileStorage;
  private settings: NovaSettings;

  constructor(userData: string) {
    this.storage = new JsonFileStorage(userData, 'settings');
    this.settings = this.storage.get<NovaSettings>('settings') ?? {};
  }

  get(): NovaSettings {
    return { ...this.settings };
  }

  set(patch: NovaSettings): void {
    this.settings = { ...this.settings, ...patch };
    this.storage.set('settings', this.settings);
    this.storage.flush();
  }

  update(partial: Partial<NovaSettings>): void {
    this.settings = { ...this.settings, ...partial };
    this.storage.set('settings', this.settings);
    this.storage.flush();
  }

  getPreferredAddress(): string {
    return this.settings.formOfAddress ?? this.settings.identity?.preferredAddress ?? 'Sir';
  }

  close(): void {
    this.storage.close();
  }
}
