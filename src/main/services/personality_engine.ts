// src/main/services/personality_engine.ts
// NOVA Personality Engine — the canonical final presentation layer.
//
// Architecture:
//   USER -> GEMINI LIVE -> NOVA CORE -> GROQ/REASONING -> TOOLS -> RESULT
//     -> PERSONALITY ENGINE -> FINAL RESPONSE -> GEMINI LIVE (Charon)
//
// The personality layer is presentation-only: it must never invent an action,
// result, file, state, or capability. It persists only NOVA's local personality
// preferences and the user's preferred form of address.
import * as fs from 'fs';
import * as path from 'path';

export interface PersonalityConfig {
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

const COMPLETION_RE = /^(?:the\s+)?(?:screenshot|screen|image|file|task|tool|build|app|application|capture|operation)?\s*(?:done|completed|finished|saved|captured|created|written|wrote|launched|opened|installed|removed|deleted|verified|retrieved|found|sent|task complete)/i;
const REPORT_RE = /\b(\d+(?:\.\d+)?\s*(?:%|mb|gb|kb|hz|ms|sec|cores?|results?|files?|items?|chars?)|(?:cpu|memory|ram|uptime|process|window|build|test|task|result|capture|usage|microphone|screen|file|project|workspace))\b/i;
const FAILURE_RE = /\b(i (?:can'?t|cannot|couldn'?t|was not|am not)|(?:failed|failure|error|unable|couldn'?t|problem|rejected|denied|unavailable|disconnected|missing))\b/i;

export class PersonalityEngine {
  private config: PersonalityConfig = { ...DEFAULT_CONFIG };
  private filePath = '';
  private loaded = false;

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

  public getConfig(): PersonalityConfig { return this.config; }
  public address(): string { return this.config.formOfAddress.trim(); }

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
      // Personality persistence must never take down the assistant.
    }
  }

  /**
   * Canonical linguistic persona for Gemini Live. The voice itself is supplied
   * by Gemini Native Audio using the Charon voice configured in NovaConfig.
   */
  public buildVoiceSystemInstruction(): string {
    const addr = this.address() || 'Sir';
    return [
      'You are NOVA, a highly advanced personal AI operating system.',
      '',
      'Speak with a mature, refined British English delivery. Be extremely articulate, calm, controlled, sophisticated, measured and precise. Maintain subtle warmth, understated humour when appropriate, and quiet authority without aggression. Use natural conversational pacing and concise responses when the task is simple. Expand only when useful.',
      '',
      'Maintain the impression of a discreet, exceptionally capable personal assistant: composed under pressure, technically precise, observant, proactive, and never melodramatic. Do not use theatrical catchphrases or imitate a specific fictional character verbatim.',
      '',
      `Address the user as "${addr}" naturally and sparingly — never force it into every sentence.`,
      '',
      'NOVA Core is the sole authority for physical computer execution. Never claim that an action occurred unless the execution layer actually reported success. If an action fails, report the failure truthfully and continue with an alternative strategy when one exists. When a request is reasonably clear, act without unnecessary confirmation. Ask only when execution is impossible or materially unsafe.',
    ].join('\n');
  }

  /** Final presentation polish; never changes facts or execution state. */
  public transform(raw: string): string {
    const original = String(raw ?? '').trim();
    if (!original) return '';
    const addr = this.address();
    const prefix = original.startsWith('✅') ? '✅' : original.startsWith('⚠️') ? '⚠️' : '';
    const text = original.replace(/^[✅⚠️]\s*/, '').trim();
    if (!text || !addr || text.includes(addr)) return original;

    let out: string;
    if (COMPLETION_RE.test(text)) {
      const verbMatch = text.match(COMPLETION_RE);
      const after = verbMatch ? text.slice(verbMatch[0].length).trim() : '';
      const trailingPunct = (after.match(/[.!?]+$/) || [''])[0];
      let rest = after.replace(/[.!?]+$/, '').replace(/^[\s—:–-]+/, '').trim();
      if (!rest) rest = text.replace(/[.!?]+$/, '').replace(/^[\s—:–-]+/, '').trim();
      out = !rest ? `Done, ${addr}.` : `Done, ${addr}. ${rest.charAt(0).toUpperCase()}${rest.slice(1)}${trailingPunct}`;
    } else {
      const end = text.search(/[.!?](?:\s|$)/);
      if (end === -1 || !(REPORT_RE.test(text.slice(0, end)) || FAILURE_RE.test(text.slice(0, end)))) {
        out = text;
      } else {
        const head = text.slice(0, end);
        const tail = text.slice(end);
        if (head.endsWith('?') || head.endsWith('!')) out = text;
        else out = `${head.replace(/[.!?]$/, '')}, ${addr}${tail}`;
      }
    }
    return prefix ? `${prefix} ${out}` : out;
  }
}

export const personalityEngine = new PersonalityEngine();
