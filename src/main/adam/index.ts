// A.D.A.M. — additive systems coordinator.
// Merged into the restored legacy backend as an ADDITIVE capability layer.
// This module instantiates and wires all the new self-management systems
// (health, maintenance, error observability, learning, upgrades, self-repair,
// diagnostics, subagents, model matrix, state machine, wake-word, Charon TTS)
// against the EXISTING legacy backend services — without modifying those
// services. The legacy main.ts calls `initAdamSystems(deps)` exactly once.
//
// This is deliberately a single, additive integration point: the old backend's
// existing behavior is preserved; these systems plug into it.
import type { AiProvider, AiProviderRegistry } from '../services/ai_provider';
import type { ToolRegistry } from '../services/tool_registry';
import type { MemoryEngine } from '../services/memory_engine';
import type { PythonRuntime } from '../services/python_runtime';
import { AdamIdentity } from './identity';
import { AdamStateMachine } from './state_machine';
import { AdamHealthEngine } from './health_engine';
import { AdamErrorObservabilityEngine } from './error_observability';
import { AdamMaintenanceEngine } from './maintenance_engine';
import { AdamLearningEngine } from './learning_engine';
import { AdamUpgradeEngine } from './upgrade_engine';
import { AdamTrialManager } from './trial_manager';
import { AdamSelfRepairEngine } from './self_repair';
import { AdamDiagnosticsEngine } from './diagnostics';
import { AdamSubagentOrchestrator } from './subagents';
import { AdamModelMatrix } from './model_matrix';
import { AdamWakeWordDetector } from './wake_word';
import { AdamCharonTTS } from './charon_tts';

export interface AdamSystemDeps {
  registry: ToolRegistry;
  providers: AiProviderRegistry;
  memory: MemoryEngine;
  python: PythonRuntime;
  userData: string;
  /** Returns the primary coding provider (Groq preferred). */
  codingProvider: () => AiProvider | null;
}

export interface AdamSystems {
  identity: typeof AdamIdentity;
  state: AdamStateMachine;
  health: AdamHealthEngine;
  errors: AdamErrorObservabilityEngine;
  maintenance: AdamMaintenanceEngine;
  learning: AdamLearningEngine;
  upgrades: AdamUpgradeEngine;
  trials: AdamTrialManager;
  repair: AdamSelfRepairEngine;
  diagnostics: AdamDiagnosticsEngine;
  subagents: AdamSubagentOrchestrator;
  models: AdamModelMatrix;
  wake: AdamWakeWordDetector;
  charon: AdamCharonTTS;
  start(): void;
  stop(): void;
  pause(): void;
  resume(): void;
  shutdown(): void;
}

/**
 * Initialize the additive A.D.A.M. systems against the legacy backend.
 * Call ONCE from the legacy main process after the orchestrator/services are
 * up. Returns a handle for lifecycle control.
 */
export function initAdamSystems(deps: AdamSystemDeps): AdamSystems {
  const identity = AdamIdentity;
  const state = new AdamStateMachine();
  const errors = new AdamErrorObservabilityEngine();
  const health = new AdamHealthEngine(deps.registry, deps.providers, () => deps.python.isWorkerAlive());
  const maintenance = new AdamMaintenanceEngine(health, errors, 15000);
  const learning = new AdamLearningEngine(deps.memory);
  const upgrades = new AdamUpgradeEngine(deps.userData);
  const trials = new AdamTrialManager(upgrades, health);
  const repair = new AdamSelfRepairEngine(deps.registry, deps.providers, deps.userData);
  const diagnostics = new AdamDiagnosticsEngine(health, errors, deps.registry, deps.providers);
  const subagents = new AdamSubagentOrchestrator(() => deps.codingProvider());
  const models = new AdamModelMatrix(deps.providers);
  const wake = new AdamWakeWordDetector();
  const charon = new AdamCharonTTS(deps.python);

  return {
    identity,
    state,
    health,
    errors,
    maintenance,
    learning,
    upgrades,
    trials,
    repair,
    diagnostics,
    subagents,
    models,
    wake,
    charon,
    start() {
      maintenance.start();
      upgrades.start();
    },
    stop() {
      maintenance.stop();
      upgrades.stop();
      subagents.disposeAll();
    },
    pause() {
      maintenance.pause();
    },
    resume() {
      maintenance.resume();
    },
    shutdown() {
      maintenance.stop();
      upgrades.stop();
      trials.abort();
      subagents.disposeAll();
    },
  };
}
