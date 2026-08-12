// New Backend — index.ts
// NovaBackend facade — the public entry point for the New Backend. Wires every
// engine, owns startup/shutdown via the Lifecycle Engine, and exposes a clean
// API for the Electron adapter and tests. This is the ONLY object the host
// (Electron) talks to.
import { join } from 'node:path';
import { Nova2Config } from './core/config.js';
import { logger, createConsoleSink } from './core/logger.js';
import { SecretStore } from './security/secret_store.js';
import { PiiSanitizer } from './security/sanitizer.js';
import { PathGuard } from './security/path_guard.js';
import { PythonRuntimeBridge } from './execution/PythonRuntimeBridge.js';
import { ToolLibrary } from './persistence/tool_library.js';
import { MemoryEngine } from './memory/MemoryEngine.js';
import { ExecutionLedger } from './persistence/execution_ledger.js';
import { SettingsStore } from './persistence/settings_store.js';
import { TelemetryEngine } from './telemetry/TelemetryEngine.js';
import { EnvironmentEngine } from './environment/EnvironmentEngine.js';
import { WorkspaceEngine } from './workspace/WorkspaceEngine.js';
import { VoiceEngine } from './voice/VoiceEngine.js';
import { GroqProvider } from './providers/GroqProvider.js';
import { GeminiProvider } from './providers/GeminiProvider.js';
import { ProviderRegistry } from './providers/ProviderRegistry.js';
import { AgentSelector } from './reasoning/AgentSelector.js';
import { CapabilityDiscoveryEngine } from './capability/CapabilityDiscoveryEngine.js';
import { NovaAgent } from './orchestration/NovaAgent.js';
import { LifecycleEngine } from './lifecycle/LifecycleEngine.js';
import { registerBuiltins } from './tools/BuiltinTools.js';
import { registerStandardVerifiers } from './verification/VerificationEngine.js';
import { InputEngine } from './input/InputEngine.js';
import type { RequestEnvelope, RequestSource } from './contracts/domain.js';
import type { BootStatePayload, RuntimeStatePayload } from './contracts/ipc.js';

export interface NovaBackendOptions {
  silent?: boolean;
  logLevel?: 'debug' | 'info' | 'warn' | 'error';
}

export class NovaBackend {
  readonly config = Nova2Config;
  readonly secrets: SecretStore;
  readonly pathGuard: PathGuard;
  readonly bridge: PythonRuntimeBridge;
  readonly library: ToolLibrary;
  readonly memory: MemoryEngine;
  readonly ledger: ExecutionLedger;
  readonly settings: SettingsStore;
  readonly telemetry: TelemetryEngine;
  readonly environment: EnvironmentEngine;
  readonly workspace: WorkspaceEngine;
  readonly voice: VoiceEngine;
  readonly providers: ProviderRegistry;
  readonly selector: AgentSelector;
  readonly lifecycle: LifecycleEngine;
  readonly input: InputEngine;
  agent: NovaAgent | null = null;
  private ready = false;

  constructor(options: NovaBackendOptions = {}) {
    if (!options.silent) logger.configure(options.logLevel ?? 'info', createConsoleSink());

    const ud = Nova2Config.paths.userData;
    this.secrets = new SecretStore(Nova2Config.paths.vaultPath);
    this.pathGuard = new PathGuard();
    this.bridge = new PythonRuntimeBridge();
    this.library = new ToolLibrary(ud);
    this.memory = new MemoryEngine(ud);
    this.ledger = new ExecutionLedger(ud);
    this.settings = new SettingsStore(ud);
    this.telemetry = new TelemetryEngine(ud);
    this.environment = new EnvironmentEngine();
    this.workspace = new WorkspaceEngine(ud);
    this.voice = new VoiceEngine(Nova2Config.voice.wakeWord);
    this.providers = new ProviderRegistry();
    this.selector = new AgentSelector(this.providers);
    this.lifecycle = new LifecycleEngine();
    this.input = new InputEngine();
  }

  private initProviders(): void {
    const groq = new GroqProvider();
    groq.configure(this.secrets.get('GROQ_API_KEY'));
    const gemini = new GeminiProvider();
    gemini.configure(this.secrets.get('GEMINI_API_KEY'));
    this.providers.register(groq);
    this.providers.register(gemini);
  }

  private initAgent(): void {
    const selector = this.selector;
    this.agent = new NovaAgent(
      this.library,
      this.memory,
      this.ledger,
      this.telemetry,
      this.workspace,
      this.environment,
      selector,
      this.bridge,
      () => selector.trySelect('reasoning'),
    );
    // Register audited built-in handlers onto the agent's execution engine.
    registerBuiltins(this.agent.engines.executor, { bridge: this.bridge, workspace: this.workspace });
    registerStandardVerifiers(this.agent.engines.verification, this.library);
  }

  /** Start the backend following the lifecycle order. Returns true when READY. */
  async start(): Promise<boolean> {
    const ok = await this.lifecycle.startup({
      config: () => { this.initProviders(); },
      python: async () => { const avail = await this.bridge.probeAvailability(); if (!avail) logger.warn('[backend] python runtime unavailable'); },
      tools: () => { const report = this.library.hydrateFromDisk(); logger.info('[backend] tool library hydrated', { ...report }); },
      memory: () => { /* memory engine already constructed */ },
      environment: () => { /* environment engine already constructed */ },
      providers: () => { this.initProviders(); },
      voice: () => { /* voice engine constructed */ },
      capability: () => { /* discovery engine available via agent */ },
      orchestrator: () => { this.initAgent(); },
    });
    if (ok) {
      this.ready = true;
      logger.info('[backend] NOVA New Backend READY');
    }
    return ok;
  }

  isReady(): boolean {
    return this.ready;
  }

  /** Handle a raw text request from any source. Returns a NovaResult. */
  async handleRequest(text: string, source: RequestSource = 'typed'): Promise<ReturnType<NovaAgent['run']>> {
    if (!this.agent) throw new Error('NOVA backend is not initialized. Call start() first.');
    const envelope = this.input.normalize(text, source, { wakeWordDetected: source === 'whisper' });
    return this.agent.run(envelope);
  }

  /** Handle an already-normalized request envelope. */
  async handleEnvelope(envelope: RequestEnvelope): Promise<ReturnType<NovaAgent['run']>> {
    if (!this.agent) throw new Error('NOVA backend is not initialized.');
    return this.agent.run(envelope);
  }

  // --- Frontend-facing queries (used by the Electron adapter) ---
  runtimeState(): RuntimeStatePayload {
    return {
      bootedAt: this.settings.get().identity ? Date.now() : Date.now(),
      overall: this.ready ? 'ONLINE' : 'BOOTING',
      python: this.ready ? 'online' : 'starting',
      providers: Object.fromEntries(this.providers.all().map(p => [p.id, p.isConfigured() ? 'configured' : 'unconfigured'])),
      capabilityIndex: this.ready ? 'online' : 'starting',
      orchestrator: this.agent ? 'online' : 'starting',
      currentTask: this.ready ? 'Ready' : 'Booting',
      lastError: null,
      uptimeMs: Date.now() - this.startedAt(),
      timestamp: Date.now(),
      backend: 'NEW_BACKEND_v2',
    };
  }

  private startedAt(): number {
    return (this as { _startedAt?: number })._startedAt ?? Date.now();
  }

  bootState(): BootStatePayload {
    return {
      bootSteps: this.lifecycle.getSteps().map(s => ({ stepId: s.stepId, label: s.label, status: s.status, timestamp: s.timestamp })),
      timestamp: Date.now(),
      backend: 'NEW_BACKEND_v2',
    };
  }

  listCapabilities(): Array<{ technicalId: string; name: string; description: string; category: string; version: string }> {
    return this.library.all().map(t => ({ technicalId: t.technicalId, name: t.displayName, description: t.description, category: t.category, version: t.version }));
  }

  toolRegistryView(): unknown {
    return this.library.all().map(t => ({
      id: t.id,
      name: t.displayName,
      technicalId: t.technicalId,
      description: t.description,
      category: t.category,
      version: t.version,
      status: t.status,
      health: t.health,
      successRate: t.executionCount > 0 ? Number((t.successCount / t.executionCount).toFixed(2)) : 0,
      executionCount: t.executionCount,
      enabled: t.enabled,
    }));
  }

  /** Graceful shutdown following the lifecycle order. */
  async shutdown(): Promise<void> {
    await this.lifecycle.shutdown({
      orchestrator: () => { this.agent = null; },
      capability: () => {},
      voice: () => {},
      providers: () => {},
      environment: () => {},
      memory: () => this.memory.flush(),
      tools: () => this.library.flush(),
      python: () => {},
      config: () => {},
    });
    this.telemetry.flush();
    this.telemetry.close();
    this.ledger.close();
    this.workspace.closeStore();
    this.settings.close();
    this.library.close();
    this.memory.close();
    this.ready = false;
    logger.info('[backend] NOVA New Backend shutdown complete');
  }

  /** Convenience for tests/CLI. */
  static create(options: NovaBackendOptions = {}): NovaBackend {
    return new NovaBackend(options);
  }
}

export { Nova2Config } from './core/config.js';
export { PiiSanitizer };
export type { RequestEnvelope, RequestSource } from './contracts/domain.js';
export { NovaIpcChannel } from './contracts/ipc.js';
