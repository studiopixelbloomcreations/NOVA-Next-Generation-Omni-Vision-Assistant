// New Backend — input/InputEngine.ts
// Accepts Whisper transcripts, typed requests, multimodal and system-triggered
// inputs and normalizes them into a RequestEnvelope. Adds a stable requestId
// (duplicate-prevention key) and current context.
import { randomUUID } from 'node:crypto';
import type { EnvironmentSnapshot, RequestEnvelope, RequestSource } from '../contracts/domain.js';
import { logger } from '../core/logger.js';
import { sanitizeSecrets } from '../security/sanitizer.js';

export interface InputContext {
  currentWorkspace?: string;
  currentTask?: string;
  wakeWordDetected?: boolean;
  language?: string;
  environmentSnapshot?: EnvironmentSnapshot | null;
  memoryContext?: string[];
}

export class InputEngine {
  /** Build a normalized RequestEnvelope from raw text. */
  normalize(
    transcript: string,
    source: RequestSource,
    context: InputContext = {},
  ): RequestEnvelope {
    const clean = sanitizeSecrets(String(transcript ?? '').trim());
    const envelope: RequestEnvelope = {
      requestId: randomUUID(),
      timestamp: Date.now(),
      source,
      transcript: clean,
      language: context.language ?? 'en',
      wakeWordDetected: context.wakeWordDetected ?? false,
      currentWorkspace: context.currentWorkspace,
      currentTask: context.currentTask,
      memoryContext: context.memoryContext,
      environmentSnapshot: context.environmentSnapshot ?? undefined,
    };
    if (!clean) {
      logger.debug('[input] normalized empty request', { source });
    }
    return envelope;
  }

  /** Idempotence helper: derive a canonical id for a transcript+source pair. */
  static canonicalKey(transcript: string, source: RequestSource): string {
    return `${source}:${String(transcript).trim().toLowerCase()}`;
  }
}
