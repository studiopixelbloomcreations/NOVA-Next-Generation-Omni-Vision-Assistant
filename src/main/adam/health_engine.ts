// A.D.A.M. — additive Health Engine.
// Merged into the restored legacy backend as an ADDITIVE capability. Monitors
// subsystem health (python, providers, tools, memory) and reports a real
// health state — never fabricated.
import type { AiProviderRegistry } from '../services/ai_provider';
import type { ToolRegistry } from '../services/tool_registry';

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

export class AdamHealthEngine {
  private lastReport: HealthReport | null = null;

  constructor(
    private readonly registry: ToolRegistry,
    private readonly providers: AiProviderRegistry,
    private readonly pythonAvailable: () => boolean,
  ) {}

  async check(): Promise<HealthReport> {
    const now = Date.now();
    const subsystems: SubsystemHealth[] = [];

    // Python runtime availability.
    subsystems.push({
      subsystem: 'python',
      level: this.pythonAvailable() ? 'healthy' : 'offline',
      detail: this.pythonAvailable() ? 'Python runtime reachable' : 'Python interpreter not found',
      checkedAt: now,
    });

    // AI providers (Groq / Gemini).
    for (const p of this.providers.all()) {
      subsystems.push({
        subsystem: `provider:${p.id}`,
        level: p.isConfigured() ? 'healthy' : 'warning',
        detail: p.isConfigured() ? 'configured' : 'not configured',
        checkedAt: now,
      });
    }

    // Tool library integrity.
    const tools = this.registry.list();
    const enabled = tools.filter(t => t.enabled && t.status !== 'failed');
    const unhealthy = enabled.filter(t => t.health === 'unhealthy' || t.health === 'degraded');
    subsystems.push({
      subsystem: 'tools',
      level: unhealthy.length > 0 ? (unhealthy.some(t => t.health === 'unhealthy') ? 'warning' : 'degraded') : 'healthy',
      detail: `${enabled.length} enabled, ${unhealthy.length} degraded/unhealthy`,
      checkedAt: now,
    });

    // Memory (Node heap).
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
    return (Object.entries(rank) as [HealthLevel, number][]).sort((a, b) => b[1] - a[1]).find(([, r]) => r === max)?.[0] ?? 'healthy';
  }

  last(): HealthReport | null {
    return this.lastReport;
  }
}
