// A.D.A.M. — additive Diagnostics Engine.
// Merged into the restored legacy backend as an ADDITIVE capability. Provides a
// structured, on-demand report of backend state (health, providers, tools,
// task queue, memory, errors).
import type { AdamHealthEngine } from './health_engine';
import type { AdamErrorObservabilityEngine } from './error_observability';
import type { ToolRegistry } from '../services/tool_registry';
import type { AiProviderRegistry } from '../services/ai_provider';

export class AdamDiagnosticsEngine {
  private activeTasks = 0;

  constructor(
    private readonly health: AdamHealthEngine,
    private readonly errors: AdamErrorObservabilityEngine,
    private readonly registry: ToolRegistry,
    private readonly providers: AiProviderRegistry,
  ) {}

  markTaskStarted(): void { this.activeTasks += 1; }
  markTaskEnded(): void { this.activeTasks = Math.max(0, this.activeTasks - 1); }

  async collect(): Promise<Record<string, unknown>> {
    const mem = process.memoryUsage();
    const tools = this.registry.list();
    return {
      generatedAt: Date.now(),
      uptimeMs: process.uptime() * 1000,
      memory: {
        heapUsedMb: Math.round(mem.heapUsed / 1024 / 1024),
        heapTotalMb: Math.round(mem.heapTotal / 1024 / 1024),
        rssMb: Math.round(mem.rss / 1024 / 1024),
      },
      health: await this.health.check(),
      providers: Object.fromEntries(this.providers.all().map(p => [p.id, p.describe()])),
      tools: {
        total: tools.length,
        enabled: tools.filter(t => t.enabled && t.status !== 'failed').length,
        degraded: tools.filter(t => t.health === 'degraded').length,
        unhealthy: tools.filter(t => t.health === 'unhealthy').length,
      },
      errors: {
        total: this.errors.all().length,
        critical: this.errors.all().filter(e => e.severity === 'critical').length,
        recent60s: this.errors.countSince(60_000),
      },
      taskQueue: { activeTasks: this.activeTasks },
    };
  }
}
