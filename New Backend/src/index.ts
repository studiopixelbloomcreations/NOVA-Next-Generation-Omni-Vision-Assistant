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
import { WakeWordDetector } from './voice/WakeWordDetector.js';
import { MicCapture } from './voice/MicCapture.js';
import { WhisperTranscriber } from './voice/WhisperTranscriber.js';
import { GeminiLiveBridge } from './voice/GeminiLiveBridge.js';
import { CharonTTS } from './voice/CharonTTS.js';
import { GroqProvider } from './providers/GroqProvider.js';
import { GeminiProvider } from './providers/GeminiProvider.js';
import { ProviderRegistry } from './providers/ProviderRegistry.js';
import { AgentSelector } from './reasoning/AgentSelector.js';
import { CapabilityDiscoveryEngine } from './capability/CapabilityDiscoveryEngine.js';
import { NovaAgent } from './orchestration/NovaAgent.js';
import { AgentOrchestrator } from './orchestration/AgentOrchestrator.js';
import { LifecycleEngine } from './lifecycle/LifecycleEngine.js';
import { StateMachine } from './lifecycle/StateMachine.js';
import { PersonalityEngine } from './reasoning/PersonalityEngine.js';
import { OutputEngine } from './reasoning/OutputEngine.js';
import { HealthEngine } from './maintenance/HealthEngine.js';
import { ValidationEngine } from './validation/ValidationEngine.js';
import { ToolTestingEngine } from './testing/ToolTestingEngine.js';
import { ErrorObservabilityEngine } from './maintenance/ErrorObservabilityEngine.js';
import { MaintenanceEngine } from './maintenance/MaintenanceEngine.js';
import { SelfRepairEngine } from './maintenance/SelfRepairEngine.js';
import { LearningEngine } from './maintenance/LearningEngine.js';
import { UpgradeEngine } from './upgrades/UpgradeEngine.js';
import { TrialManager } from './upgrades/TrialManager.js';
import { SelfMaintenanceCoordinator } from './maintenance/SelfMaintenanceCoordinator.js';
import { DiagnosticsEngine } from './diagnostics/DiagnosticsEngine.js';
import { registerBuiltins, registerBuiltinCapabilities } from './tools/BuiltinTools.js';
import { registerStandardVerifiers } from './verification/VerificationEngine.js';
import { InputEngine } from './input/InputEngine.js';
import { Identity } from './contracts/identity.js';
import type { ExecutionLedgerEntry, RequestEnvelope, RequestSource } from './contracts/domain.js';
import type { BootStatePayload, RuntimeStatePayload, SystemTelemetryPayload, MicStatePayload, ContextChipPayload, ActivityEvent } from './contracts/ipc.js';

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
  readonly stateMachine: StateMachine;
  readonly errors: ErrorObservabilityEngine;
  readonly health: HealthEngine;
  readonly maintenance: MaintenanceEngine;
  readonly selfRepair: SelfRepairEngine;
  readonly learning: LearningEngine;
  readonly upgrades: UpgradeEngine;
  readonly personality: PersonalityEngine;
  readonly output: OutputEngine;
  readonly subagents: AgentOrchestrator;
  readonly wakeDetector: WakeWordDetector;
  readonly mic: MicCapture;
  readonly whisper: WhisperTranscriber;
  readonly liveBridge: GeminiLiveBridge;
  readonly charon: CharonTTS;
  readonly maintenanceCoordinator: SelfMaintenanceCoordinator;
  readonly trialManager: TrialManager;
  readonly diagnostics: DiagnosticsEngine;
  agent: NovaAgent | null = null;
  private ready = false;
  private closeHandler: (() => void) | null = null;

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
    // Voice subsystem (System 29): wake word ADAM, mic, Whisper, Gemini Live, Charon.
    this.wakeDetector = new WakeWordDetector();
    this.mic = new MicCapture();
    this.whisper = new WhisperTranscriber(this.bridge);
    this.liveBridge = new GeminiLiveBridge();
    this.liveBridge.on('error', (err: Error) => {
      this.errors?.capture({ subsystem: 'gemini_live', message: err?.message ?? String(err) }, err);
      logger.warn('[backend] Gemini Live error', { error: err?.message ?? String(err) });
    });
    this.charon = new CharonTTS(this.bridge);
    this.voice = new VoiceEngine(this.wakeDetector, this.mic, this.whisper, this.liveBridge, this.charon);
    this.providers = new ProviderRegistry();
    this.selector = new AgentSelector(this.providers);
    this.lifecycle = new LifecycleEngine();
    this.stateMachine = new StateMachine();
    this.input = new InputEngine();
    this.errors = new ErrorObservabilityEngine(ud);
    this.personality = new PersonalityEngine(this.settings);
    this.output = new OutputEngine(this.personality);
    // Health/Maintenance/Upgrade/SelfRepair/Learning constructed after their
    // dependencies exist (bridge/library/providers are ready above).
    this.health = new HealthEngine(this.library, this.bridge, this.providers);
    this.maintenance = new MaintenanceEngine(this.health, this.errors, this.library);
    this.selfRepair = new SelfRepairEngine(this.library, this.selector, new ValidationEngine(this.bridge), new ToolTestingEngine(this.bridge), this.bridge);
    this.learning = new LearningEngine(this.memory);
    this.upgrades = new UpgradeEngine(ud);
    this.subagents = new AgentOrchestrator(this.selector);
    this.maintenanceCoordinator = new SelfMaintenanceCoordinator(this.library, this.selfRepair);
    this.trialManager = new TrialManager(this.upgrades, this.health);
    this.diagnostics = new DiagnosticsEngine(this.health, this.errors, this.library, this.providers, this.bridge);
    // Auto-respond to maintenance findings by staging validated repairs (System 18).
    this.maintenance.on('finding', (f) => {
      void this.maintenanceCoordinator.handleFinding(f as never).catch(() => undefined);
    });
  }

  private initProviders(): void {
    const groq = new GroqProvider();
    groq.configure(this.secrets.get('GROQ_API_KEY'));
    const gemini = new GeminiProvider();
    gemini.configure(this.secrets.get('GEMINI_API_KEY'));
    this.providers.register(groq);
    this.providers.register(gemini);
    // Gemini Live conversational head.
    this.liveBridge.configure(this.secrets.get('GEMINI_API_KEY'));
    this.providers.startAutoRefresh(30_000);
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
      this.stateMachine,
      this.learning,
      this.errors,
      this.subagents,
      this.diagnostics,
    );
    // Register audited built-in handlers onto the agent's execution engine and
    // expose them to capability discovery as system tools.
    registerBuiltins(this.agent.engines.executor, { bridge: this.bridge, workspace: this.workspace });
    registerBuiltinCapabilities(this.library);
    registerStandardVerifiers(this.agent.engines.verification, this.library);
    // Feed the Gemini Live head the current tool declarations so it can call
    // back into A.D.A.M. capabilities.
    this.liveBridge.setToolDeclarations(this.agent.buildToolDeclarations());
    // Wire self-close (System 30) to the host shutdown path.
    this.agent.on('close-request', () => {
      this.closeHandler?.();
    });
    // Continuous self-monitoring + upgrade engines run while the app is open.
    this.maintenance.start();
    this.upgrades.start();
    // Always-on voice loop.
    this.voice.start();
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
      voice: () => {
        this.voice.start();
        this.connectLive();
      },
      capability: () => { /* discovery engine available via agent */ },
      orchestrator: () => { this.initAgent(); },
    });
    if (ok) {
      this.ready = true;
      this.stateMachine.transition('READY');
      logger.info(`[backend] ${Identity.name} New Backend READY (wake word: ${Identity.wakeWord})`);
    }
    return ok;
  }

  isReady(): boolean {
    return this.ready;
  }

  /** Handle a raw text request from any source. Returns a NovaResult. */
  async handleRequest(text: string, source: RequestSource = 'typed'): Promise<ReturnType<NovaAgent['run']>> {
    if (!this.agent) throw new Error(`${Identity.name} backend is not initialized. Call start() first.`);
    if (this.stateMachine.isBusy()) this.stateMachine.transition('UNDERSTANDING');
    this.maintenance.pause(); // defer maintenance during a critical user operation
    const envelope = this.input.normalize(text, source, { wakeWordDetected: source === 'whisper' });
    const result = await this.agent.run(envelope);
    this.maintenance.resume();
    // Learn from the task and present through the coherent Output + Personality
    // layer so the user experiences a single cohesive assistant.
    this.learning.learnFromTask(result.entry);
    this.liveBridge.setToolDeclarations(this.agent.buildToolDeclarations());
    if (result.status === 'completed') this.stateMachine.resetToIdle();
    return result;
  }

  /** Compose the final user-facing response for a ledger entry (Output + Personality). */
  composeResponse(entry: ExecutionLedgerEntry): string {
    return this.output.compose(entry);
  }

  /** Handle an already-normalized request envelope. */
  async handleEnvelope(envelope: RequestEnvelope): Promise<ReturnType<NovaAgent['run']>> {
    if (!this.agent) throw new Error('NOVA backend is not initialized.');
    return this.agent.run(envelope);
  }

  /** Register the host callback invoked on a self-close request (System 30). */
  onCloseRequested(handler: () => void): void {
    this.closeHandler = handler;
  }

  // --- Voice-facing API (System 29) ---

  /** Feed a PCM frame (16kHz mono) into wake detection + Whisper. */
  processAudioFrame(pcm: Int16Array | number[]): void {
    this.voice.processAudioFrame(pcm);
  }

  /** Speak a response in the Charon voice. */
  async speak(text: string): Promise<boolean> {
    return this.voice.speak(text);
  }

  /** Connect the Gemini Live conversational head (called after providers init). */
  connectLive(): void {
    if (this.liveBridge.isConnected()) return;
    void this.liveBridge.connectStream();
  }

  disconnectLive(): void {
    this.liveBridge.disconnectStream();
  }

  // --- Self-management / diagnostics API ---

  async diagnosticsReport(): Promise<ReturnType<DiagnosticsEngine['collect']>> {
    return this.diagnostics.collect();
  }

  maintenanceFindings(): unknown[] {
    return this.maintenance.findingsList();
  }

  readyUpgradeProposals(): unknown[] {
    return this.upgrades.readyUpgrades();
  }

  startUpgradeTrial(id: string): boolean {
    return this.trialManager.startTrial(id);
  }

  acceptUpgradeTrial(): void {
    this.trialManager.accept();
  }

  // --- Frontend-facing queries (used by the Electron adapter) ---
  /** Exact IRuntimeStatePayload shape the frontend consumes. */
  runtimeState(): RuntimeStatePayload {
    const groqOk = this.providers.get('groq')?.isConfigured() ?? false;
    const geminiOk = this.providers.get('gemini')?.isConfigured() ?? false;
    return {
      bootedAt: this.startedAt(),
      overall: this.ready ? 'ONLINE' : 'BOOTING',
      electron: 'online',
      python: 'online',
      gemini: geminiOk ? 'online' : 'unconfigured',
      groq: groqOk ? 'online' : 'unconfigured',
      memory: this.memory ? 'online' : 'offline',
      toolRegistry: this.agent ? 'online' : 'starting',
      toolExecutor: this.agent ? 'online' : 'starting',
      microphone: this.mic?.snapshot?.available ? 'online' : 'offline',
      speaker: this.charon ? 'online' : 'offline',
      details: {
        wakeWord: Identity.wakeWord,
        identity: Identity.name,
        voice: Identity.voice,
      },
      currentTask: this.ready ? 'Ready' : 'Booting',
      lastError: null,
      uptimeMs: Date.now() - this.startedAt(),
      timestamp: Date.now(),
    };
  }

  /** Build a live system-telemetry payload for the ~1Hz frontend stream. */
  systemTelemetry(): SystemTelemetryPayload {
    return {
      captureWidth: 1280,
      captureHeight: 720,
      frameRate: 0,
      mutatedBlocks: 0,
      totalBlocks: 0,
      geminiState: this.liveBridge.getConnectionState(),
      streamLatencyMs: 0,
      timestamp: Date.now(),
    };
  }

  /** Build the exact IMicStatePayload shape the frontend consumes. */
  micState(): MicStatePayload {
    const snap = this.mic.snapshot;
    return {
      state: snap.state,
      available: snap.available,
      listening: snap.listening,
      muted: snap.muted,
      devices: [],
      defaultCapture: snap.defaultCapture,
      lastError: snap.lastError,
      lastDiagnostic: null,
      timestamp: Date.now(),
    };
  }

  /** Build context chips from the current environment/runtime truth. */
  async contextChips(): Promise<ContextChipPayload> {
    const chips: ContextChipPayload['chips'] = [
      { id: 'identity', label: Identity.name, type: 'status', severity: 'low' },
      { id: 'wake', label: `Wake: ${Identity.wakeWord}`, type: 'status', severity: 'low' },
      { id: 'voice', label: `Voice: ${Identity.voice}`, type: 'status', severity: 'low' },
      { id: 'tools', label: `${this.library.all().filter(t => t.enabled).length} tools`, type: 'status', severity: 'low' },
    ];
    if (!this.providers.get('groq')?.isConfigured()) {
      chips.push({ id: 'groq', label: 'Groq not configured', type: 'alert', severity: 'medium' });
    }
    if (!this.providers.get('gemini')?.isConfigured()) {
      chips.push({ id: 'gemini', label: 'Gemini not configured', type: 'alert', severity: 'medium' });
    }
    return { chips };
  }

  recentActivity(limit = 20): ActivityEvent[] {
    return this.ledger.recent(limit).map(e => ({
      id: e.executionId,
      ts: e.startedAt,
      level: e.status === 'completed' ? 'success' : e.status === 'failed' ? 'error' : 'info',
      message: (e.summary || e.transcript).slice(0, 120),
    }));
  }

  private startedAt(): number {
    return (this as { _startedAt?: number })._startedAt ?? Date.now();
  }

  bootState(): BootStatePayload {
    return {
      bootSteps: this.lifecycle.getSteps().map(s => ({ stepId: s.stepId, label: s.label, status: s.status, timestamp: s.timestamp })),
      telemetry: this.systemTelemetry(),
      voiceState: this.liveBridge.getConnectionState(),
      providers: {
        gemini: this.providers.get('gemini')?.isConfigured() ?? false,
        groq: this.providers.get('groq')?.isConfigured() ?? false,
        liveConnected: this.liveBridge.isConnected(),
      },
      timestamp: Date.now(),
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

  /** Graceful shutdown following the lifecycle order (no zombie workers). */
  async shutdown(): Promise<void> {
    this.stateMachine.transition('SHUTTING_DOWN');
    await this.lifecycle.shutdown({
      orchestrator: () => {
        this.maintenance.stop();
        this.upgrades.stop();
        this.subagents.disposeAll();
        this.trialManager.abort();
        this.agent = null;
      },
      capability: () => {},
      voice: () => {
        this.voice.stop();
        this.disconnectLive();
      },
      providers: () => {
        this.providers.stopAutoRefresh();
      },
      environment: () => {},
      memory: () => this.memory.flush(),
      tools: () => this.library.flush(),
      python: () => {},
      config: () => {},
    });
    this.telemetry.flush();
    this.telemetry.close();
    this.errors.close();
    this.upgrades.close();
    this.ledger.close();
    this.workspace.closeStore();
    this.settings.close();
    this.library.close();
    this.memory.close();
    this.ready = false;
    this.stateMachine.transition('OFFLINE');
    logger.info(`[backend] ${Identity.name} New Backend shutdown complete`);
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
