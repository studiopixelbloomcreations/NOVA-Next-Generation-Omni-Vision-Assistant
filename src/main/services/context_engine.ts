// src/main/services/context_engine.ts
import { EventEmitter } from 'events';
import { execFile } from 'child_process';
import { graphEngine } from '../db/graph_engine';
import { IContextChipPayload } from '../../shared/ipc_protocols';

const POLL_INTERVAL_MS = 2000;
const TITLE_MAX_LENGTH = 40;

// P/Invoke script: resolves the foreground window's owning process name and
// title without native Node dependencies. Prints "processName|windowTitle".
const FOREGROUND_WINDOW_SCRIPT = `
Add-Type @"
using System;using System.Runtime.InteropServices;using System.Text;
public class FG {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder t, int c);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
}
"@
$h=[FG]::GetForegroundWindow();$sb=New-Object System.Text.StringBuilder 512;[FG]::GetWindowText($h,$sb,512)|Out-Null;$pid2=0;[FG]::GetWindowThreadProcessId($h,[ref]$pid2)|Out-Null;$p=(Get-Process -Id $pid2 -ErrorAction SilentlyContinue).ProcessName;Write-Output "$p|$($sb.ToString())"
`.trim();

export class ContextEngine extends EventEmitter {
  private currentChips: IContextChipPayload['chips'] = [];
  private pollTimer: NodeJS.Timeout | null = null;
  private pollInFlight: boolean = false;
  private lastForegroundKey: string = '';
  private hasLoggedPollError: boolean = false;

  public start(): void {
    if (this.pollTimer) return;
    void this.pollForegroundWindow();
    this.pollTimer = setInterval(() => {
      void this.pollForegroundWindow();
    }, POLL_INTERVAL_MS);
  }

  public stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  public getActiveChips(): IContextChipPayload {
    return { chips: [...this.currentChips] };
  }

  public calculateRank(similarity: number, pathDistance: number, lastAccessedEpoch: number): number {
    const elapsedSeconds = (Date.now() - lastAccessedEpoch) / 1000;
    return graphEngine.calculateContextRank(similarity, pathDistance, elapsedSeconds);
  }

  private async pollForegroundWindow(): Promise<void> {
    if (this.pollInFlight) return;
    this.pollInFlight = true;
    try {
      const output = await this.queryForegroundWindow();
      this.hasLoggedPollError = false;

      const separatorIdx = output.indexOf('|');
      if (separatorIdx < 0) return;

      const processName = output.slice(0, separatorIdx).trim();
      const windowTitle = output.slice(separatorIdx + 1).trim();
      if (!processName) return;

      const key = `${processName}|${windowTitle}`;
      if (key === this.lastForegroundKey) return;
      this.lastForegroundKey = key;

      const truncatedTitle =
        windowTitle.length > TITLE_MAX_LENGTH
          ? `${windowTitle.slice(0, TITLE_MAX_LENGTH)}…`
          : windowTitle;

      this.currentChips = [
        {
          id: '1',
          label: truncatedTitle ? `${processName}: ${truncatedTitle}` : processName,
          type: 'application',
          severity: 'low',
        },
      ];

      this.emit('context-changed', this.getActiveChips());
    } catch (err) {
      // Keep last-known chips; a transient PowerShell failure should not blank context.
      if (!this.hasLoggedPollError) {
        this.hasLoggedPollError = true;
        console.error('[context_engine] foreground window poll failed (suppressing repeats until recovery):', err);
      }
    } finally {
      this.pollInFlight = false;
    }
  }

  private queryForegroundWindow(): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(
        'powershell',
        ['-NoProfile', '-NonInteractive', '-Command', FOREGROUND_WINDOW_SCRIPT],
        { timeout: 5000, windowsHide: true },
        (error, stdout) => {
          if (error) {
            reject(error);
          } else {
            resolve(stdout.trim());
          }
        }
      );
    });
  }
}

export const contextEngine = new ContextEngine();
