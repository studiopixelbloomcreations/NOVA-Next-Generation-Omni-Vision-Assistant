// src/main/services/context_engine.ts
import { EventEmitter } from 'events';
import { spawn, ChildProcess } from 'child_process';
import { graphEngine } from '../db/graph_engine';
import { IContextChipPayload } from '../../shared/ipc_protocols';

const POLL_INTERVAL_MS = 2000;
const TITLE_MAX_LENGTH = 40;

let powershellProcess: ChildProcess | null = null;

function startPowerShellSession(): ChildProcess | null {
  const ps = spawn('powershell', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    '-'
  ], {
    windowsHide: true
  });

  // Attach stdout handler immediately to catch __NOVA_READY__
  (ps as any).outputBuffer = '';
  (ps as any).ready = false;
  (ps as any).pendingResolve = null;
  (ps as any).pendingReject = null;

  ps.stdout?.on('data', (data: Buffer) => {
    (ps as any).outputBuffer += data.toString();
    
    while ((ps as any).outputBuffer.includes('__NOVA_READY__')) {
      const idx = (ps as any).outputBuffer.indexOf('__NOVA_READY__');
      (ps as any).outputBuffer = (ps as any).outputBuffer.slice(idx + '__NOVA_READY__'.length);
      (ps as any).ready = true;
      console.log('[context_engine] PowerShell session ready');
    }
    
    while ((ps as any).outputBuffer.includes('__NOVA_QUERY_COMPLETE__')) {
      const idx = (ps as any).outputBuffer.indexOf('__NOVA_QUERY_COMPLETE__');
      const result = (ps as any).outputBuffer.slice(0, idx).trim();
      (ps as any).outputBuffer = (ps as any).outputBuffer.slice(idx + '__NOVA_QUERY_COMPLETE__'.length);
      
      if ((ps as any).pendingResolve) {
        (ps as any).pendingResolve(result);
        (ps as any).pendingResolve = null;
        (ps as any).pendingReject = null;
      }
    }
  });

  ps.stderr?.on('data', (data: Buffer) => {
    console.error('[context_engine] PowerShell stderr:', data.toString());
  });

  ps.on('error', (err) => {
    console.error('[context_engine] PowerShell process error:', err);
    (ps as any).ready = false;
    if ((ps as any).pendingReject) {
      (ps as any).pendingReject(err);
      (ps as any).pendingResolve = null;
      (ps as any).pendingReject = null;
    }
  });

  ps.on('exit', (code) => {
    console.error('[context_engine] PowerShell process exited with code:', code);
    (ps as any).ready = false;
    if ((ps as any).pendingReject) {
      (ps as any).pendingReject(new Error(`PowerShell process exited with code ${code}`));
      (ps as any).pendingResolve = null;
      (ps as any).pendingReject = null;
    }
  });

  // Initialize the session with the FG class definition
  const initScript = `
$sig = @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class FG {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder t, int c);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
}
"@

if (-not ("FG" -as [type])) {
    Add-Type -TypeDefinition $sig -Language CSharp
}

function Get-ForegroundWindowInfo {
  $h = [FG]::GetForegroundWindow()
  $sb = New-Object System.Text.StringBuilder 512
  [FG]::GetWindowText($h, $sb, 512) | Out-Null
  $procId = 0
  [FG]::GetWindowThreadProcessId($h, [ref]$procId) | Out-Null
  $p = (Get-Process -Id $procId -ErrorAction SilentlyContinue).ProcessName
  $title = $sb.ToString()
  if ($title) { Write-Output "$p|$title" } else { Write-Output "$p|" }
}

Write-Output "__NOVA_READY__"
`.trim();

  ps.stdin?.write(initScript + '\n');

  return ps;
}

function ensurePowerShellSession(): Promise<ChildProcess> {
  if (!powershellProcess || !(powershellProcess as any).ready) {
    if (powershellProcess) {
      try { powershellProcess.kill(); } catch {}
    }
    powershellProcess = startPowerShellSession();
    
    // Wait for initialization
    return new Promise((resolve, reject) => {
      const checkReady = setInterval(() => {
        if (powershellProcess && (powershellProcess as any).ready) {
          clearInterval(checkReady);
          resolve(powershellProcess!);
        }
      }, 50);
      
      setTimeout(() => {
        clearInterval(checkReady);
        reject(new Error('PowerShell session initialization timeout'));
      }, 5000);
    });
  }
  return Promise.resolve(powershellProcess!);
}

function queryForegroundWindow(): Promise<string> {
  return new Promise(async (resolve, reject) => {
    let ps: ChildProcess;
    try {
      ps = await ensurePowerShellSession();
    } catch (err) {
      reject(err);
      return;
    }

    (ps as any).pendingResolve = resolve;
    (ps as any).pendingReject = reject;

    const queryScript = `
Get-ForegroundWindowInfo
Write-Output "__NOVA_QUERY_COMPLETE__"
`.trim();

    ps.stdin?.write(queryScript + '\n');

    // Timeout safety
    setTimeout(() => {
      if ((ps as any).pendingResolve) {
        (ps as any).pendingResolve = null;
        (ps as any).pendingReject = null;
        reject(new Error('PowerShell query timeout'));
        // Force restart on timeout
        try { ps.kill(); } catch {}
        powershellProcess = null;
      }
    }, 2500);
  });
}

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
    if (powershellProcess) {
      try { powershellProcess.kill(); } catch {}
      powershellProcess = null;
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
      const output = await queryForegroundWindow();
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
      if (!this.hasLoggedPollError) {
        this.hasLoggedPollError = true;
        console.error('[context_engine] foreground window poll failed (suppressing repeats until recovery):', err);
      }
      // Force restart PowerShell session on error
      if (powershellProcess) {
        try { powershellProcess.kill(); } catch {}
        powershellProcess = null;
      }
    } finally {
      this.pollInFlight = false;
    }
  }
}

export const contextEngine = new ContextEngine();