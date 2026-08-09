import { NovaIpcChannel } from '../../shared/ipc_protocols';
import { PiiSanitizer } from './pii_sanitizer';

export class IpcFirewall {
  private allowedChannels: Set<string>;
  private blockedChannels: Set<string>;

  constructor() {
    this.allowedChannels = new Set<string>();
    this.blockedChannels = new Set<string>();

    const allNovaChannels = Object.values(NovaIpcChannel) as string[];
    for (const channel of allNovaChannels) {
      this.allowedChannels.add(channel);
    }

    const internalChannels: string[] = [
      'nova-ipc:boot-lifecycle',
      'ai-audio-chunk',
      'ai-text-token',
      'agent-tool-created',
      'agent-tool-synthesis-phase',
      'agent-tool-synthesis-steps',
      'agent-tool-approval-request',
      'agent-progress-update',
      'wake-word-detected',
      'audio-buffer-flush',
      'user-audio-chunk',
      'user-speaking-active',
      'camera-frame',
      'nova-sys:mic-capture-active',
      'nova-sys:mic-capture-error',
    ];

    for (const channel of internalChannels) {
      this.allowedChannels.add(channel);
    }
  }

  allow(channel: string): void {
    this.allowedChannels.add(channel);
    this.blockedChannels.delete(channel);
  }

  block(channel: string): void {
    this.blockedChannels.add(channel);
    this.allowedChannels.delete(channel);
  }

  isAllowed(channel: string): boolean {
    if (this.blockedChannels.has(channel)) {
      return false;
    }
    if (this.allowedChannels.has(channel)) {
      return true;
    }
    return false;
  }

  filter(channel: string, args: any[]): any[] {
    if (!this.isAllowed(channel)) {
      return [];
    }
    return args.map((arg) => PiiSanitizer.sanitizeObject(arg));
  }
}

export const ipcFirewall = new IpcFirewall();
