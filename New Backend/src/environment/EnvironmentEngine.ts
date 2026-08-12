// New Backend — environment/EnvironmentEngine.ts
// Environment Observation Engine. Builds an EnvironmentSnapshot before NOVA
// plans/acts: platform, CPU, memory, hostname, cwd, workspace/tools dirs,
// running apps/processes, network state, Python availability. Real data where
// the host allows; graceful degradation otherwise (never fabricated success).
import { cpus, hostname, platform, arch, release, totalmem, freemem, homedir, EOL } from 'node:os';
import { join } from 'node:path';
import type { EnvironmentSnapshot } from '../contracts/domain.js';
import { Nova2Config } from '../core/config.js';
import { logger } from '../core/logger.js';

export class EnvironmentEngine {
  async observe(): Promise<EnvironmentSnapshot> {
    const cpusList = cpus();
    const cpuModel = cpusList.length > 0 ? cpusList[0].model : 'unknown';
    const snapshot: EnvironmentSnapshot = {
      platform: platform(),
      arch: arch(),
      osRelease: release(),
      hostname: hostname(),
      cpuModel,
      cpuCores: cpusList.length,
      totalMemoryMb: Math.round(totalmem() / 1024 / 1024),
      freeMemoryMb: Math.round(freemem() / 1024 / 1024),
      activeWindow: null,
      runningApps: [],
      processes: [],
      clipboard: null,
      cwd: process.cwd(),
      homeDir: Nova2Config.home || homedir(),
      workspaceDir: Nova2Config.paths.userData,
      toolsDir: Nova2Config.paths.toolsRoot,
      pythonAvailable: false,
      pythonVersion: undefined,
      networkUp: false,
      capturedAt: Date.now(),
    };

    // Running apps / processes (best-effort, platform-aware).
    try {
      const procs = await this.sampleProcesses();
      snapshot.processes = procs.slice(0, 40);
      snapshot.runningApps = procs.map(p => p.name).slice(0, 20);
    } catch (err) {
      logger.debug('[environment] process sampling unavailable', { error: String(err) });
    }

    // Network: resolve a well-known host (best-effort, short timeout).
    try {
      const up = await this.probeNetwork();
      snapshot.networkUp = up;
    } catch {
      snapshot.networkUp = false;
    }

    // Python availability (best-effort).
    try {
      const { execSync } = await import('node:child_process');
      const out = execSync(
        `${Nova2Config.forge.pythonExecutable} -c "import sys; print(sys.version.split()[0])"`,
        { timeout: 5000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] },
      ).toString().trim();
      snapshot.pythonAvailable = true;
      snapshot.pythonVersion = out;
    } catch {
      snapshot.pythonAvailable = false;
    }

    return snapshot;
  }

  private async sampleProcesses(): Promise<Array<{ pid: number; name: string }>> {
    if (platform() === 'win32') {
      // Windows: use PowerShell one-liner (best-effort).
      try {
        const { execSync } = await import('node:child_process');
        const out = execSync(
          `powershell -NoProfile -Command "Get-Process | Select-Object -First 40 ProcessName,Id | ConvertTo-Json -Compress"`,
          { timeout: 5000, windowsHide: true },
        ).toString().trim();
        const parsed = JSON.parse(out);
        const arr = Array.isArray(parsed) ? parsed : [parsed];
        return arr
          .filter((p: { ProcessName?: string }) => p?.ProcessName)
          .map((p: { ProcessName: string; Id: number }) => ({ pid: p.Id, name: p.ProcessName }));
      } catch {
        return [];
      }
    }
    // POSIX: read /proc (Linux).
    try {
      const { readdirSync, readFileSync } = await import('node:fs');
      const procs: Array<{ pid: number; name: string }> = [];
      for (const pid of readdirSync('/proc')) {
        if (!/^\d+$/.test(pid)) continue;
        try {
          const statm = readFileSync(join('/proc', pid, 'comm'), 'utf-8').trim();
          procs.push({ pid: Number(pid), name: statm });
        } catch {
          /* skip */
        }
      }
      procs.sort((a, b) => b.pid - a.pid);
      return procs;
    } catch {
      return [];
    }
  }

  private async probeNetwork(): Promise<boolean> {
    try {
      const { resolve } = await import('node:dns').catch(() => ({ resolve: null as never }));
      if (typeof resolve !== 'function') return false;
      return await new Promise<boolean>(res => {
        resolve('one.one.one.one', (err: Error | null) => res(!err));
      });
    } catch {
      return false;
    }
  }
}
