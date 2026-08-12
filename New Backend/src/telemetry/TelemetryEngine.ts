// New Backend — telemetry/TelemetryEngine.ts
// Central telemetry collection. Every engine emits structured samples here.
// The engine aggregates latency/success metrics and can persist them.
import type { EngineTelemetry, TelemetrySample } from '../contracts/domain.js';
import { JsonFileStorage } from '../persistence/storage.js';
import { logger } from '../core/logger.js';

type MetricKey = 'request' | 'planning' | 'provider' | 'tool' | 'forge' | 'sandbox' | 'verification' | 'overall';

class MetricAccumulator {
  private samples: number[] = [];
  private failures = 0;

  add(durationMs: number, ok = true): void {
    this.samples.push(durationMs);
    if (this.samples.length > 200) this.samples.shift();
    if (!ok) this.failures++;
  }

  average(): number {
    if (this.samples.length === 0) return 0;
    return Math.round(this.samples.reduce((a, b) => a + b, 0) / this.samples.length);
  }

  count(): number {
    return this.samples.length;
  }

  failureCount(): number {
    return this.failures;
  }
}

export class TelemetryEngine {
  private metrics = new Map<MetricKey, MetricAccumulator>();
  private retryCount = 0;
  private storage: JsonFileStorage | null = null;
  private liveSinks: Array<(sample: TelemetrySample) => void> = [];

  constructor(userData?: string) {
    if (userData) this.storage = new JsonFileStorage(userData, 'telemetry');
    for (const k of ['request', 'planning', 'provider', 'tool', 'forge', 'sandbox', 'verification', 'overall'] as MetricKey[]) {
      this.metrics.set(k, new MetricAccumulator());
    }
  }

  onSample(sink: (sample: TelemetrySample) => void): void {
    this.liveSinks.push(sink);
  }

  /** Emit a structured latency sample. */
  record(category: MetricKey, durationMs: number, ok = true, extra?: Record<string, unknown>): void {
    const acc = this.metrics.get(category);
    if (acc) acc.add(durationMs, ok);
    if (category === 'overall' && !ok) this.retryCount++;
    const sample: TelemetrySample = { ts: Date.now(), category, metric: category, valueMs: durationMs, ok, extra };
    if (this.storage) {
      const existing = this.storage.get<TelemetrySample[]>('samples') ?? [];
      existing.push(sample);
      if (existing.length > 1000) existing.shift();
      this.storage.set('samples', existing);
      this.storage.flush();
    }
    for (const sink of this.liveSinks) {
      try { sink(sample); } catch { /* ignore */ }
    }
  }

  snapshot(): EngineTelemetry {
    return {
      requestLatencyMs: this.metrics.get('request')?.average() ?? 0,
      planningLatencyMs: this.metrics.get('planning')?.average() ?? 0,
      providerLatencyMs: this.metrics.get('provider')?.average() ?? 0,
      toolLatencyMs: this.metrics.get('tool')?.average() ?? 0,
      forgeLatencyMs: this.metrics.get('forge')?.average() ?? 0,
      sandboxLatencyMs: this.metrics.get('sandbox')?.average() ?? 0,
      verificationLatencyMs: this.metrics.get('verification')?.average() ?? 0,
      overallTaskMs: this.metrics.get('overall')?.average() ?? 0,
      successRate: this.computeSuccessRate(),
      retryCount: this.retryCount,
    };
  }

  private computeSuccessRate(): number {
    let ok = 0;
    let total = 0;
    for (const [k, acc] of this.metrics) {
      if (k === 'overall') continue;
      ok += acc.count() - acc.failureCount();
      total += acc.count();
    }
    return total === 0 ? 1 : Number((ok / total).toFixed(3));
  }

  flush(): void {
    logger.debug('[telemetry] snapshot', { ...this.snapshot() });
    this.storage?.flush();
  }

  close(): void {
    this.storage?.close();
  }
}
