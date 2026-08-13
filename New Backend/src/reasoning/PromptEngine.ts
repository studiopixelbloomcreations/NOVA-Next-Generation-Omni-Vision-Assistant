// New Backend — reasoning/PromptEngine.ts
// The ONLY place in the backend where model prompts are constructed. No engine
// scatters large prompt strings. It builds prompts from goal, environment,
// memory, available capabilities, tool contracts, platform, security
// constraints, output schema, and verification/failure strategies.
import type { CapabilityMatch, EnvironmentSnapshot, ExecutionPlan, MemoryEntry } from '../contracts/domain.js';
import { Nova2Config } from '../core/config.js';
import { Identity } from '../contracts/identity.js';

export class PromptEngine {
  /** Intent classification prompt (AI-assisted, with a deterministic fallback). */
  buildIntentPrompt(request: string, env: EnvironmentSnapshot | null): string {
    return `${Identity.systemPersona} You are the Intent Engine. Classify the following user request into exactly one intent.
Request: "${request}"
Platform: ${env?.platform ?? 'unknown'}
Return ONLY JSON: {"kind":"<one of conversational|informational|workspace|computer_task|multi_step_task|engineering_task|tool_creation|system_task|background_task>","label":"<short verb phrase>","action":"<primary action verb>","entities":["<key noun phrases>"],"needsResearch":<bool>,"needsToolCreation":<bool>,"confidence":<0..1>}`;
  }

  /** Planning prompt fed with the capability catalog. */
  buildPlanPrompt(request: string, catalog: string, maxSteps: number): string {
    return `${Identity.systemPersona} You are the autonomous planning engine. You are not the conversational voice; you are the execution planner.
USER OBJECTIVE: ${request}

AVAILABLE CAPABILITIES:
${catalog || '(none)'}

Produce a concrete, machine-executable plan. Prefer existing tools. If a required capability is missing, set "tool" to null and describe the capability that must be created. Do not ask the user questions; infer sensible defaults. Each step must have an observable success condition and at least one fallback strategy. Keep the plan <= ${maxSteps} steps.

Return ONLY JSON:
{"goal":"<objective>","steps":[{"id":"1","goal":"<step goal>","capability":"<capability or null>","tool":"<existing tool name or null>","args":{},"verification":"<observable success condition>","fallbackStrategies":["..."],"timeoutMs":30000}]}`;
  }

  /** Tool-forge prompt demanding REAL Python source + tests, never fake success. */
  buildForgePrompt(
    capability: string,
    previousFailure: string | null,
    catalog: string,
  ): string {
    const repairBlock = previousFailure
      ? `\n\nThe previously generated code FAILED its isolated sandbox tests with this output:\n\`\`\`\n${previousFailure.slice(0, 2500)}\n\`\`\`\nAnalyze the failure and generate a corrected version that fixes it. Do not weaken the requested behavior.`
      : '';
    return `${Identity.systemPersona} You are the Tool Forge. Design a REAL, reusable capability for the request: "${capability}".

Do not ask the user follow-up questions. Infer sensible defaults and produce an executable tool now. The tool must implement real functionality — not return an explanation, not echo the input, not be a wrapper that just calls a model again, and not hardcode the answer.

Use ONLY the Python standard library unless an approved dependency is declared. Do not use subprocess, socket, ctypes, os.system, eval, exec, or write outside a passed path. Validate inputs. Return a JSON-serializable dict with a "success" boolean and a structured result. Expose useful errors.

ALREADY-EXISTING CAPABILITIES (do not duplicate): ${catalog || '(none)'}

Return ONLY a JSON object with this exact shape:
{
  "displayName": "Human-friendly tool name, e.g. File Scout",
  "technicalId": "stable_lowercase_id",
  "description": "one sentence describing the capability",
  "category": "files|windows|system|network|media|utility",
  "capabilities": ["DIRECTORY_ANALYSIS", "FILE_SCOUT"],
  "permissions": [{"type":"fs-read","scope":["*"]}],
  "dependencies": [],
  "pythonSource": "COMPLETE Python module source. It MUST define: def run(params: dict) -> dict. Real implementation only. No markdown fences.",
  "testSource": "COMPLETE Python test module source. It MUST do 'from tool import run', call run() with sample params, assert real behavior with Python 'assert' statements, CALL ITS OWN TEST FUNCTIONS AT MODULE LEVEL so they actually execute, and end with print('ALL_TESTS_PASSED'). No markdown fences."
}
${repairBlock}
Output ONLY the JSON object.`;
  }

  /** Verification prompt. */
  buildVerificationPrompt(request: string, step: string, expected: string, payload: string): string {
    return `Verify an action NOVA just performed on the user computer.
USER REQUEST: ${request}
STEP: ${step}
EXPECTED: ${expected}
RESULT: ${payload.slice(0, 5000)}
Return ONLY JSON: {"passed":true|false,"detail":"short factual reason"}. Do not invent evidence.`;
  }

  /** Reasoning prompt for informational/conversational research work. */
  buildReasoningPrompt(request: string, memory: string[], context: string): string {
    return `${Identity.systemPersona} Answer the user's request precisely and concisely.
Relevant memory context:
${memory.length ? memory.map(m => `- ${m}`).join('\n') : '(none)'}

Task context:
${context}

User request: ${request}`;
  }

  /** Contextualizes an execution plan for the Output/Personality layer. */
  planContext(plan: ExecutionPlan | null, matches: CapabilityMatch[], memory: MemoryEntry[]): string {
    return JSON.stringify({ goal: plan?.goal ?? null, steps: plan?.steps.length ?? 0, matches: matches.length, memories: memory.length });
  }

  get forgeConstraints(): string {
    return `Platform: ${process.platform}; Python runtime is required. Security: no secrets in prompts; ${Nova2Config.forge.maxSourceBytes} byte source limit.`;
  }
}
