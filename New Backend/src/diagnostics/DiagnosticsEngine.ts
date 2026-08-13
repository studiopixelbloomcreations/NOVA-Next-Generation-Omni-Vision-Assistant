// New Backend — diagnostics/DiagnosticsEngine.ts
// Diagnostics Engine (System 24/40 complement). Provides on-demand, structured
// diagnostics for any subsystem: runs targeted probes and returns a normalized
// diagnostic report (health, providers, tools, task queue, memory, errors,
// recent failures). It is the single place A.D.A.M. can inspect its own state
// for maintenance, self-repair and the user-visible diagnostics surface.
import { ToolLibrary } from '../persistence/tool_library.js';
import { HealthEngine } from '../maintenance/HealthEngine.js';
import { ErrorObservabilityEngine } from '../maintenance/ErrorObservabilityEngine.js';
import { ProviderRegistry } from '../providers/ProviderRegistry.js';
import { PythonRuntimeBridge } from '../execution/PythonRuntimeBridge.js';

export interface DiagnosticsReport {
  generatedAt: number;
  uptimeMs: number;
  memory: { heapUsedMb: number; heapTotalMb: number; rssMb: number };
  health: Awaited<ReturnType<HealthEngine['check']>> | null;
  providers: ReturnType<ProviderRegistry['describe']>;
  tools: { total: number; enabled: number; degraded: number; unhealthy: number };
  errors: { total: number; critical: number; recent60s: number };
  taskQueue: { activeTasks: number };
}

export class DiagnosticsEngine {
  private activeTasks = 0;

  constructor(
    private readonly health: HealthEngine,
    private readonly errors: ErrorObservabilityEngine,
    private readonly library: ToolLibrary,
    private readonly providers: ProviderRegistry,
    private readonly bridge: PythonRuntimeBridge,
  ) {}

  markTaskStarted(): void { this.activeTasks += 1; }
  markTaskEnded(): void { this.activeTasks = Math.max(0, this.activeTasks - 1); }

  async collect(): Promise<DiagnosticsReport> {
    const mem = process.memoryUsage();
    const health = await this.health.check();
    const tools = this.library.all();
    return {
      generatedAt: Date.now(),
      uptimeMs: process.uptime() * 1000,
      memory: {
        heapUsedMb: Math.round(mem.heapUsed / 1024 / 1024),
        heapTotalMb: Math.round(mem.heapTotal / 1024 / 1024),
        rssMb: Math.round(mem.rss / 1024 / 1024),
      },
      health,
      providers: this.providers.describe(),
      tools: {
        total: tools.length,
        enabled: tools.filter(t => t.enabled).length,
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
