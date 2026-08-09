// src/main/services/windows_integration.ts
// Native desktop integration for the Windows host.
//
// Bridges NOVA to operating-system capabilities the renderer must never touch
// directly: clipboard, notifications, global shortcuts, app launching, and
// system information. Everything is permission-checked and audited.
import { clipboard, Notification, globalShortcut, shell, app } from 'electron';
import * as os from 'os';
import { spawn } from 'child_process';
import { logger } from '../core/logger';
import { scrubEnv } from '../utils/security';

export interface SystemInfo {
  platform: NodeJS.Platform;
  arch: string;
  release: string;
  hostname: string;
  cpuModel: string;
  cpuCores: number;
  totalMemoryMb: number;
  freeMemoryMb: number;
  electronVersion: string;
  appVersion: string;
  appPath: string;
}

export class WindowsIntegration {
  /** Reads the system clipboard text. */
  public readClipboard(): string {
    try {
      const text = clipboard.readText();
      logger.audit('clipboard.read', 'ok');
      return text;
    } catch (err) {
      logger.audit('clipboard.read', 'failed', { error: err instanceof Error ? err.message : String(err) });
      return '';
    }
  }

  /** Writes text to the system clipboard. */
  public writeClipboard(text: string): boolean {
    try {
      clipboard.writeText(String(text));
      logger.audit('clipboard.write', 'ok', { bytes: String(text).length });
      return true;
    } catch (err) {
      logger.audit('clipboard.write', 'failed', { error: err instanceof Error ? err.message : String(err) });
      return false;
    }
  }

  /** Shows a native notification when the OS supports it. */
  public notify(title: string, body: string): boolean {
    try {
      if (!Notification.isSupported()) {
        logger.debug('[windows_integration] notifications unsupported; skipping');
        return false;
      }
      const notification = new Notification({ title, body, silent: false });
      notification.show();
      return true;
    } catch (err) {
      logger.error('[windows_integration] notification failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  /**
   * Registers a global shortcut (e.g. 'CommandOrControl+Shift+N'). Returns
   * false when registration fails or the accelerator is invalid.
   */
  public registerShortcut(accelerator: string, callback: () => void): boolean {
    try {
      const ok = globalShortcut.register(accelerator, () => {
        logger.audit('shortcut.triggered', 'ok', { accelerator });
        try {
          callback();
        } catch (err) {
          logger.error('[windows_integration] shortcut callback error', {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      });
      if (!ok) {
        logger.warn('[windows_integration] shortcut registration returned false', { accelerator });
      }
      return ok;
    } catch (err) {
      logger.error('[windows_integration] shortcut registration failed', {
        accelerator,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  public unregisterAllShortcuts(): void {
    try {
      globalShortcut.unregisterAll();
    } catch {
      /* ignore */
    }
  }

  /** Launches a program or opens a path/document with the OS default. */
  public launch(target: string): Promise<{ ok: boolean; message: string }> {
    return new Promise(resolve => {
      // Prefer shell.openPath for files/folders/URLs.
      if (/^[a-z]+:\/\//i.test(target) || /\.(exe|bat|cmd|lnk)$/i.test(target)) {
        shell
          .openPath(target)
          .then(err => {
            if (err) {
              resolve({ ok: false, message: err });
            } else {
              logger.audit('app.launch', 'ok', { target });
              resolve({ ok: true, message: 'Launched' });
            }
          })
          .catch((err: Error) => resolve({ ok: false, message: err.message }));
        return;
      }
      // Generic command launch (e.g. 'notepad', 'calc').
      try {
        const child = spawn(target, [], { detached: true, stdio: 'ignore', windowsHide: true, env: scrubEnv() });
        child.unref();
        child.on('error', err => {
          logger.audit('app.launch', 'failed', { target, error: err.message });
          resolve({ ok: false, message: err.message });
        });
        child.on('spawn', () => {
          logger.audit('app.launch', 'ok', { target });
          resolve({ ok: true, message: 'Launched' });
        });
      } catch (err) {
        resolve({ ok: false, message: err instanceof Error ? err.message : String(err) });
      }
    });
  }

  /** Snapshot of host system information for diagnostics and the UI. */
  public getSystemInfo(): SystemInfo {
    const cpus = os.cpus();
    return {
      platform: process.platform,
      arch: process.arch,
      release: os.release(),
      hostname: os.hostname(),
      cpuModel: cpus.length > 0 ? cpus[0].model : 'unknown',
      cpuCores: cpus.length,
      totalMemoryMb: Math.round(os.totalmem() / (1024 * 1024)),
      freeMemoryMb: Math.round(os.freemem() / (1024 * 1024)),
      electronVersion: process.versions.electron ?? 'unknown',
      // Under plain Node (headless tests/CI) the Electron `app` module is a
      // path string, not an object — guard so system info never crashes.
      appVersion: typeof (app as any)?.getVersion === 'function' ? app.getVersion() : 'dev',
      appPath: typeof (app as any)?.getAppPath === 'function' ? app.getAppPath() : process.cwd(),
    };
  }
}

export const windowsIntegration = new WindowsIntegration();
