// New Backend — intent/IntentEngine.ts
// Intent Engine. Classifies a request into a StructuredIntent. Uses AI-assisted
// classification when a reasoning provider is configured, with a deterministic
// keyword fallback so the engine is never a hard single point of failure and
// is fully testable offline. Classification is NOT primarily regex — the AI
// path runs first; regex is a recovery path.
import type { IntentKind, RequestEnvelope, StructuredIntent } from '../contracts/domain.js';
import type { AiProvider } from '../providers/ProviderTypes.js';
import { PromptEngine } from '../reasoning/PromptEngine.js';
import { logger } from '../core/logger.js';

const TOOL_CREATION_HINTS =
  /\b(create|build|make|write|generate|forge)\b.*\b(tool|capability|skill|module|script)\b|\b(analyze|report|scout|watch)\b.*\b(directory|folder)\b/i;
const RESEARCH_HINTS =
  /\b(research|latest|news|summary|summarize|search|report on|investigate|what.?s new|developments)\b/i;
const ENGINEERING_HINTS =
  /\b(debug|refactor|implement|architect|review|code|function|class|api|database|bug|syntax|test|module|package|script|program)\b/i;
const COMPUTER_TASK_HINTS =
  /\b(open|launch|start|run|screenshot|screen|capture|clipboard|notify|process|window|file|folder|download|install|create|write|save|list|scan)\b/i;
const WORKSPACE_HINTS =
  /\b(show me|play|open|watch|stream|video|website|url|pdf|document|news)\b/i;
const SYSTEM_TASK_HINTS =
  /\b(system|shutdown|restart|sleep|volume|brightness|battery|network|wifi|bluetooth)\b/i;

function classifyDet(): StructuredIntent {
  return { kind: 'conversational', label: 'conversation', entities: [], confidence: 0.5, raw: '', action: '', needsResearch: false, needsToolCreation: false };
}

export class IntentEngine {
  private readonly prompts: PromptEngine;

  constructor(prompts: PromptEngine = new PromptEngine()) {
    this.prompts = prompts;
  }

  /**
   * Classify a request envelope. When `provider` is supplied, AI-assisted
   * classification runs first and falls back to the deterministic classifier
   * on any error or malformed output.
   */
  async classify(envelope: RequestEnvelope, provider?: AiProvider | null): Promise<StructuredIntent> {
    if (provider && provider.isConfigured()) {
      try {
        const prompt = this.prompts.buildIntentPrompt(envelope.transcript, envelope.environmentSnapshot ?? null);
        const raw = await provider.generate(prompt, { maxOutputTokens: 256, temperature: 0 });
        const parsed = this.parseAIIntent(raw, envelope.transcript);
        if (parsed) {
          logger.debug('[intent] AI-assisted classification', { kind: parsed.kind, confidence: parsed.confidence });
          return parsed;
        }
      } catch (err) {
        logger.warn('[intent] AI classification failed; using deterministic fallback', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return this.classifyDeterministic(envelope.transcript);
  }

  /** Deterministic recovery classifier (fully offline, testable). */
  classifyDeterministic(raw: string): StructuredIntent {
    const text = raw.trim();
    const lower = ` ${text.toLowerCase()} `;
    const has = (re: RegExp) => re.test(lower);

    let kind: IntentKind = 'conversational';
    let label = 'conversation';
    let action = '';
    const entities: string[] = [];
    let needsResearch = false;
    let needsToolCreation = false;
    let confidence = 0.6;

    if (has(TOOL_CREATION_HINTS) || /tool that|capability that|create a tool|analyze a directory|analyze.*folder|analyze.*downloads/i.test(lower)) {
      kind = 'tool_creation';
      label = 'tool_creation';
      action = 'create_tool';
      needsToolCreation = true;
      confidence = 0.92;
      const m = text.match(/(?:analyze|report|scout|watch)\s+(?:the\s+)?([a-z_ ]+)/i);
      if (m) entities.push(m[1].trim());
    } else if (has(ENGINEERING_HINTS) && (has(/analyze|debug|write|create|fix|implement|explain|review/) || /engineering/i.test(lower))) {
      kind = 'engineering_task';
      label = 'engineering_task';
      action = 'engineering';
      confidence = 0.8;
    } else if (has(RESEARCH_HINTS)) {
      kind = 'informational';
      label = 'research';
      action = 'research';
      needsResearch = true;
      confidence = 0.85;
      const m = text.match(/(?:about|on|of|latest)\s+([A-Za-z0-9 .]+)$/i);
      if (m) entities.push(m[1].trim());
    } else if (has(SYSTEM_TASK_HINTS)) {
      kind = 'system_task';
      label = 'system_task';
      action = 'system';
      confidence = 0.78;
    } else if (has(/compute|run|execute|multi|steps|and then|then|followed by/i)) {
      kind = 'multi_step_task';
      label = 'multi_step_task';
      action = 'execute';
      confidence = 0.7;
    } else if (has(COMPUTER_TASK_HINTS)) {
      kind = 'computer_task';
      label = 'computer_task';
      action = 'execute';
      confidence = 0.8;
    } else if (has(WORKSPACE_HINTS)) {
      kind = 'workspace';
      label = 'workspace';
      action = 'show';
      confidence = 0.75;
    } else if (has(/remember|recall|memory|remind|preference|my name is/i)) {
      kind = 'system_task';
      label = 'memory';
      action = 'memory';
      confidence = 0.7;
    } else {
      kind = 'conversational';
      label = 'conversation';
      action = 'respond';
      confidence = 0.55;
    }

    return { kind, label, entities, confidence, raw: text, action, needsResearch, needsToolCreation };
  }

  private parseAIIntent(raw: string, fallbackText: string): StructuredIntent | null {
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    try {
      const parsed = JSON.parse(cleaned.slice(start, end + 1)) as Partial<StructuredIntent>;
      const validKinds = new Set<IntentKind>(['conversational', 'informational', 'workspace', 'computer_task', 'multi_step_task', 'engineering_task', 'tool_creation', 'system_task', 'background_task']);
      if (!parsed.kind || !validKinds.has(parsed.kind)) return null;
      return {
        kind: parsed.kind,
        label: String(parsed.label ?? parsed.kind),
        entities: Array.isArray(parsed.entities) ? parsed.entities.map(String) : [],
        confidence: typeof parsed.confidence === 'number' ? Math.min(1, Math.max(0, parsed.confidence)) : 0.8,
        raw: String(parsed.raw ?? fallbackText),
        action: String(parsed.action ?? ''),
        needsResearch: Boolean(parsed.needsResearch),
        needsToolCreation: Boolean(parsed.needsToolCreation),
      };
    } catch {
      return null;
    }
  }
}
