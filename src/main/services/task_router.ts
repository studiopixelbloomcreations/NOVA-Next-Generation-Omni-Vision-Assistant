// src/main/services/task_router.ts
// Task Router: classifies user intents and routes them to the correct AI
// provider. Gemini Live owns voice/conversation and media; Groq owns reasoning,
// planning, and software-engineering work (tool synthesis, debugging, review).
//
// The router is provider-agnostic: it returns a *preferred provider id* plus a
// kind label, and callers resolve the actual provider through the
// AiProviderRegistry. If the preferred provider is not configured, the caller
// falls back to the registry primary — so the system keeps working when any
// single backend is missing.

export type TaskKind =
  | 'conversation'
  | 'reasoning'
  | 'engineering'
  | 'planning'
  | 'tool_synthesis'
  | 'media'
  | 'memory';

const MEDIA_TERMS = [
  'stream', 'live', 'video', 'news', 'tv', 'broadcast', 'watch', 'feed',
  'music', 'podcast', 'movie', 'channel', 'playlist',
];

const REASONING_TERMS = [
  'analyze', 'explain', 'compare', 'evaluate', 'why', 'reasoning', 'think',
  'solve', 'calculate', 'summarize', 'interpret', 'infer', 'hypothes',
  'predict', 'decide', 'recommend',
];

const ENGINEERING_TERMS = [
  'debug', 'refactor', 'code', 'architect', 'review', 'design', 'algorithm',
  'bug', 'error', 'test', 'implement', 'function', 'class', 'api', 'database',
  'performance', 'optimize', 'compile', 'syntax', 'typescript', 'python',
  'electron', 'react', 'node', 'build', 'deploy', 'repository', 'git',
  'feature', 'module', 'dependency', 'refactor', 'crash', 'exception', 'stack',
  'parse', 'serialize', 'protocol', 'endpoint', 'schema', 'query',
];

const PLANNING_TERMS = [
  'plan', 'roadmap', 'strategy', 'milestone', 'schedule', 'steps', 'workflow',
  'organize', 'prioritize', 'sequence', 'agenda', 'outline', 'breakdown',
];

const TOOL_SYNTHESIS_TERMS = [
  'create a tool', 'build a tool', 'new tool', 'generate tool', 'synthesize',
  'capability', 'automation for', 'tool for', 'make a tool', 'write a tool',
];

const MEMORY_TERMS = [
  'remember', 'recall', 'forget', 'memory', 'remind', 'store this', 'note that',
  'what did i', 'when did i', 'who is', 'what is my preference',
];

/**
 * Classifies a free-text intent into a task kind. Heuristics are intentionally
 * simple and documented; the classification only selects a *preferred* route,
 * never gates execution.
 */
export function classifyTask(intent: string): TaskKind {
  const text = ` ${intent.toLowerCase().trim()} `;

  for (const term of TOOL_SYNTHESIS_TERMS) {
    if (text.includes(term)) return 'tool_synthesis';
  }
  for (const term of MEMORY_TERMS) {
    if (text.includes(term)) return 'memory';
  }
  for (const term of MEDIA_TERMS) {
    if (text.includes(term)) return 'media';
  }
  let engineeringHits = 0;
  for (const term of ENGINEERING_TERMS) {
    if (text.includes(term)) engineeringHits++;
  }
  if (engineeringHits >= 2) return 'engineering';
  for (const term of PLANNING_TERMS) {
    if (text.includes(term)) return 'planning';
  }
  for (const term of REASONING_TERMS) {
    if (text.includes(term)) return 'reasoning';
  }
  // A single strong engineering verb is enough to route thinking work;
  // weak single hits (api, query…) stay conversational so the live session
  // is not hijacked by one incidental keyword.
  const STRONG_ENGINEERING = ['debug', 'refactor', 'code', 'review', 'implement', 'compile', 'architect', 'bug', 'crash', 'syntax'];
  if (engineeringHits === 1 && STRONG_ENGINEERING.some(t => text.includes(t))) return 'engineering';
  return 'conversation';
}

export interface RouteDecision {
  kind: TaskKind;
  /** Preferred provider id ('groq' for thinking work, else 'gemini'). */
  providerId: string;
}

/**
 * Maps a task kind to a preferred provider id. Thinking work (reasoning,
 * engineering, planning, tool synthesis) prefers Groq; natural interaction and
 * media stay on the primary conversational provider.
 */
export function preferredProviderFor(kind: TaskKind): string {
  switch (kind) {
    case 'reasoning':
    case 'engineering':
    case 'planning':
    case 'tool_synthesis':
      return 'groq';
    default:
      return 'gemini';
  }
}

import type { AiProvider } from './ai_provider';
import { aiProviderRegistry } from './ai_provider';

export class TaskRouter {
  /** Returns the routing decision for an intent, without touching providers. */
  public route(intent: string): RouteDecision {
    const kind = classifyTask(intent);
    return { kind, providerId: preferredProviderFor(kind) };
  }

  /**
   * Resolves the best provider for a task kind: the preferred provider when it
   * is configured, otherwise the registry primary (which keeps working when a
   * single backend is missing). Returns null only when nothing is configured.
   */
  public providerFor(kind: TaskKind): AiProvider | null {
    const preferredId = preferredProviderFor(kind);
    const preferred = aiProviderRegistry.get(preferredId);
    if (preferred && preferred.isConfigured()) return preferred;
    return aiProviderRegistry.primary();
  }
}

export const taskRouter = new TaskRouter();
