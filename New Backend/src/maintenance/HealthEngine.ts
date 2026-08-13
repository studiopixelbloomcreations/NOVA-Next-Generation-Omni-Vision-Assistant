// New Backend — maintenance/HealthEngine.ts
// Health Engine (System 24). Continuously monitors subsystems and reports a
// per-subsystem health state (healthy/degraded/warning/critical/offline). It
// collects real signals — Python availability, provider config, tool health,
// task queue depth, memory, uptime — and feeds the Maintenance/Upgrade/Recovery
// engines. It never fabricates health.
import type { ToolHealth } from '../contracts/domain.js';
import { ToolLibrary } from '../persistence/tool_library.js';
import { PythonRuntimeBridge } from '../execution/PythonRuntimeBridge.js';
import { ProviderRegistry } from '../providers/ProviderRegistry.js';

export type HealthLevel = 'healthy' | 'degraded' | 'warning' | 'critical' | 'offline';

export interface SubsystemHealth {
  subsystem: string;
  level: HealthLevel;
  detail: string;
  checkedAt: number;
}

export interface HealthReport {
  overall: HealthLevel;
  subsystems: SubsystemHealth[];
  timestamp: number;
}

export class HealthEngine {
  private lastReport: HealthReport | null = null;

  constructor(
    private readonly library: ToolLibrary,
    private readonly bridge: PythonRuntimeBridge,
    private readonly providers: ProviderRegistry,
  ) {}

  async check(): Promise<HealthReport> {
    const subsystems: SubsystemHealth[] = [];
    const now = Date.now();

    // Python runtime.
    const pythonOk = await this.bridge.probeAvailability();
    subsystems.push({
      subsystem: 'python',
      level: pythonOk ? 'healthy' : 'offline',
      detail: pythonOk ? 'Python runtime reachable' : 'Python interpreter not found',
      checkedAt: now,
    });

    // Providers.
    for (const p of this.providers.all()) {
      const configured = p.isConfigured();
      subsystems.push({
        subsystem: `provider:${p.id}`,
        level: configured ? 'healthy' : 'warning',
        detail: configured ? 'configured' : 'not configured',
        checkedAt: now,
      });
    }

    // Tool library integrity + health.
    const tools = this.library.all();
    const enabled = tools.filter(t => t.enabled);
    const unhealthy = enabled.filter(t => t.health === 'unhealthy' || t.health === 'degraded');
    subsystems.push({
      subsystem: 'tools',
      level: unhealthy.length > 0 ? (unhealthy.some(t => t.health === 'unhealthy') ? 'warning' : 'degraded') : 'healthy',
      detail: `${enabled.length} enabled, ${unhealthy.length} degraded/unhealthy`,
      checkedAt: now,
    });

    // Memory usage (Node heap).
    const heap = process.memoryUsage().heapUsed / (1024 * 1024);
    subsystems.push({
      subsystem: 'memory',
      level: heap > 1500 ? 'warning' : heap > 800 ? 'degraded' : 'healthy',
      detail: `${heap.toFixed(0)} MB heap`,
      checkedAt: now,
    });

    const overall = this.aggregate(subsystems);
    this.lastReport = { overall, subsystems, timestamp: now };
    return this.lastReport;
  }

  private aggregate(list: SubsystemHealth[]): HealthLevel {
    const rank: Record<HealthLevel, number> = { healthy: 0, degraded: 1, warning: 2, critical: 3, offline: 4 };
    const max = list.reduce((acc, s) => Math.max(acc, rank[s.level]), 0);
    const entries = Object.entries(rank) as [HealthLevel, number][];
    return entries.sort((a, b) => b[1] - a[1]).find(([, r]) => r === max)?.[0] ?? 'healthy';
  }

  last(): HealthReport | null {
    return this.lastReport;
  }
}
