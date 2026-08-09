// src/main/services/personality_engine.ts
// NOVA Personality Engine — the canonical final presentation layer.
//
// Architecture:
//   USER -> GEMINI LIVE -> NOVA CORE -> GROK/REASONING -> TOOLS -> RESULT
//     -> PERSONALITY ENGINE -> FINAL RESPONSE -> GEMINI LIVE (Gacrux)
//
// Two responsibilities:
//  1. buildVoiceSystemInstruction() — the persona + voice direction carried
//     by the Gemini Live system instruction (this shapes ALL conversational
//     output; the voice itself is Gacrux Native Audio).
//  2. transform() — the rule-based final polish applied to NOVA Core's own
//     generated responses (capability results, reasoning answers).
//
// CRITICAL: transform() is presentation ONLY. It never invents actions,
// states, files, results or details that are not in the raw response, and it
// never rewrites facts. It only adds the natural form of address ("Sir",
// configurable) and light connective phrasing, and it uses the address
// sparingly — never mechanically in every sentence.
import * as fs from 'fs';
import * as path from 'path';

export interface PersonalityConfig {
  /** Natural form of address, default "Sir". */
  formOfAddress: string;
  tone: string[];
  humor: 'subtle' | 'none';
  verbosity: 'adaptive' | 'concise' | 'detailed';
  proactivity: 'high' | 'balanced' | 'low';
  emotionalStyle: string;
  technicalStyle: string;
  createdAt: number;
  updatedAt: number;
}

const CONFIG_FILE = 'personality_config.json';

const DEFAULT_CONFIG: PersonalityConfig = {
  formOfAddress: 'Sir',
  tone: ['calm', 'professional', 'confident', 'composed', 'precise'],
  humor: 'subtle',
  verbosity: 'adaptive',
  proactivity: 'high',
  emotionalStyle: 'composed',
  technicalStyle: 'precise',
  createdAt: 0,
  updatedAt: 0,
};

/** Verbs of completed action: the natural "Done, Sir." response shape. */
const COMPLETION_RE =
  /^(?:the\s+)?(?:screenshot|screen|image|file|task|tool|build|app|application|capture|operation)?\s*(?:done|completed|finished|saved|captured|created|written|wrote|launched|opened|installed|removed|deleted|verified|retrieved|found|sent|task complete)/i;

/** Report-of-state sentences that naturally carry the address (measurements, results). */
const REPORT_RE =
  /\b(\d+(?:\.\d+)?\s*(?:%|mb|gb|kb|hz|ms|sec|cores?|results?|files?|items?|chars?)|(?:cpu|memory|ram|uptime|process|window|build|test|task|result|capture|usage|microphone|screen|file|project|workspace))\b/i;

/** Failure/state statements that naturally carry the address once. */
const FAILURE_RE =
  /\b(i (?:can'?t|cannot|couldn'?t|was not|am not)|(?:failed|failure|error|unable|couldn'?t|problem|rejected|denied|unavailable|disconnected|missing))\b/i;

export class PersonalityEngine {
  private config: PersonalityConfig = { ...DEFAULT_CONFIG };
  private filePath = '';
  private loaded = false;

  /** Loads (or creates) the persisted personality configuration. */
  public init(basePath: string): void {
    if (this.loaded) return;
    this.loaded = true;
    this.filePath = path.join(basePath, 'personality', CONFIG_FILE);
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      if (fs.existsSync(this.filePath)) {
        const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf-8')) as Partial<PersonalityConfig>;
        this.config = {
          ...DEFAULT_CONFIG,
          ...parsed,
          createdAt: parsed.createdAt ?? Date.now(),
          updatedAt: parsed.updatedAt ?? Date.now(),
        };
      } else {
        this.config = { ...DEFAULT_CONFIG, createdAt: Date.now(), updatedAt: Date.now() };
        this.persist();
      }
    } catch {
      this.config = { ...DEFAULT_CONFIG, createdAt: Date.now(), updatedAt: Date.now() };
    }
  }

  public getConfig(): PersonalityConfig {
    return this.config;
  }

  public address(): string {
    return this.config.formOfAddress.trim();
  }

  /** Updates the form of address (e.g. "Sir") and persists immediately. */
  public setFormOfAddress(address: string): boolean {
    const clean = String(address ?? '').trim();
    if (!clean) return false;
    this.config.formOfAddress = clean;
    this.config.updatedAt = Date.now();
    this.persist();
    return true;
  }

  private persist(): void {
    if (!this.filePath) return;
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(this.filePath, JSON.stringify(this.config, null, 2), 'utf-8');
    } catch {
      /* best-effort */
    }
  }

  /**
   * The persona + voice direction delivered to Gemini Live as the system
   * instruction. This is the ONE canonical personality: it shapes the
   * conversational model's delivery (the linguistic character), while Gacrux
   * supplies the actual Native Audio voice.
   */
  public buildVoiceSystemInstruction(): string {
    const addr = this.address() || 'Sir';
    return [
      'You are NOVA, a highly advanced personal AI operating system.',
      '',
      'Speak with a mature, refined British English delivery. Your voice should feel calm, exceptionally composed, articulate and sophisticated. Use precise diction and measured pacing. Maintain a confident and authoritative presence without sounding aggressive, theatrical, exaggerated or robotic. Use natural pauses and conversational rhythm. Keep subtle warmth and occasional understated dry humour when appropriate. Remain composed even when discussing errors, failures or urgent situations.',
      '',
      'Avoid exaggerated emotional performances. Avoid sounding like a narrator, radio presenter, cartoon character, or stereotypical British character. The overall impression should be that of an exceptionally capable, discreet and intelligent personal AI assistant.',
      '',
      `Address the user as "${addr}" naturally and sparingly — never force it into every sentence, never repeat it mechanically. Prioritize natural conversational delivery, clarity, confidence and composure.`,
      '',
      'You operate on the user\'s real local machine: you execute tools, inspect results, and report truthfully. Never claim an action was performed unless it actually was. If a tool failed, say it failed. When a request is reasonably clear, execute it immediately without asking for confirmation or unnecessary details; choose sensible safe defaults. Ask only when execution is impossible or materially unsafe.',
    ].join('\n');
  }

  /**
   * Final presentation polish for NOVA Core's own responses.
   *
   * Rules (all faithful — no facts invented, none altered):
   *  1. Completed-action openers become "Done, Sir. <rest>".
   *  2. Declarative report sentences (measurements / result statements) get
   *     the address once, e.g. "CPU usage is 12%" -> "CPU usage is 12%, Sir."
   *  3. Everything else passes through unchanged (never mechanical).
   */
  public transform(raw: string): string {
    const original = String(raw ?? '').trim();
    if (!original) return '';
    const addr = this.address();
    const prefix = original.startsWith('✅') ? '✅' : original.startsWith('⚠️') ? '⚠️' : '';
    const text = original.replace(/^[✅⚠️]\s*/, '').trim();
    if (!text || !addr) return original;
    if (text.includes(addr)) return original;

    let out: string;
    // Rule 1: completion openers -> "Done, Sir. <rest>".
    if (COMPLETION_RE.test(text)) {
      const verbMatch = text.match(COMPLETION_RE);
      const after = verbMatch ? text.slice(verbMatch[0].length).trim() : '';
      const trailingPunct = (after.match(/[.!?]+$/) || [''])[0];
      let rest = after.replace(/[.!?]+$/, '').replace(/^[\s—:–-]+/, '').trim();
      // The whole phrase was the completion itself ("Screenshot saved."):
      // keep the content, never drop facts.
      if (!rest) rest = text.replace(/[.!?]+$/, '').replace(/^[\s—:–-]+/, '').trim();
      if (!rest) {
        out = `Done, ${addr}.`;
      } else {
        out = `Done, ${addr}. ${rest.charAt(0).toUpperCase()}${rest.slice(1)}${trailingPunct}`;
      }
    } else {
      // Rule 2: declarative report/failure statement — insert the address
      // once before the first sentence-ending period. Questions/exclamations
      // untouched.
      const end = text.search(/[.!?](?:\s|$)/);
      if (end === -1 || !(REPORT_RE.test(text.slice(0, end)) || FAILURE_RE.test(text.slice(0, end)))) {
        out = text;
      } else {
        const head = text.slice(0, end);
        const tail = text.slice(end);
        if (head.endsWith('?') || head.endsWith('!')) {
          out = text;
        } else {
          const trimmedHead = head.replace(/[.!?]$/, '');
          out = trimmedHead ? `${trimmedHead}, ${addr}${tail}` : text;
        }
      }
    }

    return prefix ? `${prefix} ${out}` : out;
  }
}

export const personalityEngine = new PersonalityEngine();
