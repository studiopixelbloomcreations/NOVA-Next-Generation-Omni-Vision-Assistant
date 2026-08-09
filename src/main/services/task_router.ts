// src/main/services/task_router.ts
// Provider-agnostic intent routing. Gemini owns conversation/media; Grok owns
// reasoning, planning, engineering and tool synthesis. NOVA Core executes.
export type TaskKind = 'conversation' | 'reasoning' | 'engineering' | 'planning' | 'tool_synthesis' | 'media' | 'memory';

const MEDIA_TERMS = ['stream','live','video','news','tv','broadcast','watch','feed','music','podcast','movie','channel','playlist'];
const REASONING_TERMS = ['analyze','explain','compare','evaluate','why','reasoning','think','solve','calculate','summarize','interpret','infer','hypothes','predict','decide','recommend'];
const ENGINEERING_TERMS = ['debug','refactor','code','architect','review','design','algorithm','bug','error','test','implement','function','class','api','database','performance','optimize','compile','syntax','typescript','python','electron','react','node','build','deploy','repository','git','feature','module','dependency','crash','exception','stack','parse','serialize','protocol','endpoint','schema','query'];
const PLANNING_TERMS = ['plan','roadmap','strategy','milestone','schedule','steps','workflow','organize','prioritize','sequence','agenda','outline','breakdown'];
const TOOL_SYNTHESIS_TERMS = ['create a tool','build a tool','new tool','generate tool','synthesize','capability','automation for','tool for','make a tool','write a tool'];
const MEMORY_TERMS = ['remember','recall','forget','memory','remind','store this','note that','what did i','when did i','who is','what is my preference'];

export function classifyTask(intent: string): TaskKind {
  const text = ` ${intent.toLowerCase().trim()} `;
  for (const term of TOOL_SYNTHESIS_TERMS) if (text.includes(term)) return 'tool_synthesis';
  for (const term of MEMORY_TERMS) if (text.includes(term)) return 'memory';
  for (const term of MEDIA_TERMS) if (text.includes(term)) return 'media';
  let engineeringHits = 0;
  for (const term of ENGINEERING_TERMS) if (text.includes(term)) engineeringHits++;
  if (engineeringHits >= 2) return 'engineering';
  for (const term of PLANNING_TERMS) if (text.includes(term)) return 'planning';
  for (const term of REASONING_TERMS) if (text.includes(term)) return 'reasoning';
  const strong = ['debug','refactor','code','review','implement','compile','architect','bug','crash','syntax'];
  if (engineeringHits === 1 && strong.some(t => text.includes(t))) return 'engineering';
  return 'conversation';
}

export interface RouteDecision { kind: TaskKind; providerId: string; }

export function preferredProviderFor(kind: TaskKind): string {
  switch (kind) {
    case 'reasoning': case 'engineering': case 'planning': case 'tool_synthesis': return 'grok';
    default: return 'gemini';
  }
}

import type { AiProvider } from './ai_provider';
import { aiProviderRegistry } from './ai_provider';

export class TaskRouter {
  public route(intent: string): RouteDecision { const kind = classifyTask(intent); return { kind, providerId: preferredProviderFor(kind) }; }
  public providerFor(kind: TaskKind): AiProvider | null {
    const preferred = aiProviderRegistry.get(preferredProviderFor(kind));
    if (preferred && preferred.isConfigured()) return preferred;
    return aiProviderRegistry.primary();
  }
}

export const taskRouter = new TaskRouter();
