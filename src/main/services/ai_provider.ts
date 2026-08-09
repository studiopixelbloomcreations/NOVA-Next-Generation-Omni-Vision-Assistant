// src/main/services/ai_provider.ts
// Provider-agnostic AI orchestration layer.
//
// NOVA treats every model backend as an `AiProvider`. The Tool Builder, the
// conversation bridge, and the orchestrator only ever talk to this interface,
// so swapping Gemini for Groq (or any future provider) requires no changes
// outside this module.
import { geminiLiveBridge } from './gemini_live_bridge';
import { logger } from '../core/logger';
import { NovaConfig } from '../core/config';

export interface GenerateOptions {
  /** Max milliseconds to wait for a complete response. */
  timeoutMs?: number;
  /** Soft cap on output tokens (some backends honor it). */
  maxOutputTokens?: number;
}

export interface AiProvider {
  readonly id: string;
  readonly label: string;
  /** True when credentials are present (even if the network is down). */
  isConfigured(): boolean;
  /** True when the provider can serve requests right now. */
  isAvailable(): boolean;
  /** Complete a prompt; used for tool/code generation. */
  generate(prompt: string, opts?: GenerateOptions): Promise<string>;
  /** Push a message into the live conversation session (best-effort). */
  sendMessage?(text: string): void;
  /** Provider-specific configuration state, safe to expose to the UI. */
  describe(): Record<string, unknown>;
}

const REST_TIMEOUT_DEFAULT_MS = 30000;

/** Accumulates a streamed text response from a Gemini Live session. */
function streamLiveText(prompt: string, timeoutMs: number): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    if (!geminiLiveBridge.isConnected() || !geminiLiveBridge.isSessionReady()) {
      reject(new Error('Gemini Live session is not ready.'));
      return;
    }

    let buffer = '';
    let lastTokenAt = Date.now();
    let settled = false;

    const onToken = (token: string): void => {
      if (settled) return;
      buffer += token;
      lastTokenAt = Date.now();
    };

    const watcher = setInterval(() => {
      if (settled) return;
      // Resolve once the model has been quiet for a beat and produced output.
      if (Date.now() - lastTokenAt > 1200 && buffer.trim().length > 0) {
        cleanup();
        resolve(buffer.trim());
      }
    }, 250);

    const timeout = setTimeout(() => {
      if (settled) return;
      cleanup();
      reject(new Error(`Gemini Live generation timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    const cleanup = (): void => {
      settled = true;
      clearInterval(watcher);
      clearTimeout(timeout);
      geminiLiveBridge.removeListener('ai-text-token', onToken);
    };

    geminiLiveBridge.on('ai-text-token', onToken);
    try {
      geminiLiveBridge.sendTextMessage(prompt);
    } catch (err) {
      cleanup();
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

/** Direct REST completion against the Gemini generateContent endpoint. */
async function geminiRestGenerate(
  apiKey: string,
  prompt: string,
  opts: GenerateOptions,
): Promise<string> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${NovaConfig.ai.codegenModel}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? REST_TIMEOUT_DEFAULT_MS);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          maxOutputTokens: opts.maxOutputTokens ?? 2048,
          temperature: 0.2,
        },
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`Gemini REST error ${response.status}: ${body.slice(0, 300)}`);
    }

    const json = (await response.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    const text = json.candidates?.[0]?.content?.parts?.map(p => p.text ?? '').join('') ?? '';
    if (!text.trim()) throw new Error('Gemini REST returned an empty completion.');
    return text.trim();
  } finally {
    clearTimeout(timer);
  }
}

export class GeminiLiveProvider implements AiProvider {
  readonly id = 'gemini';
  readonly label = 'Gemini Live';
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  setApiKey(key: string): void {
    this.apiKey = key;
  }

  isConfigured(): boolean {
    return typeof this.apiKey === 'string' && this.apiKey.trim().length > 0;
  }

  isAvailable(): boolean {
    return geminiLiveBridge.isConnected() && geminiLiveBridge.isSessionReady();
  }

  sendMessage(text: string): void {
    geminiLiveBridge.sendTextMessage(text);
  }

  async generate(prompt: string, opts: GenerateOptions = {}): Promise<string> {
    const timeoutMs = opts.timeoutMs ?? NovaConfig.ai.requestTimeoutMs;

    // Prefer the live session (lower latency, already authenticated); fall back
    // to a direct REST completion when the socket is down.
    if (this.isAvailable()) {
      try {
        return await streamLiveText(prompt, timeoutMs);
      } catch (err) {
        logger.warn('[ai_provider] live stream generation failed; trying REST', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return geminiRestGenerate(this.apiKey, prompt, opts);
  }

  describe(): Record<string, unknown> {
    return {
      id: this.id,
      configured: this.isConfigured(),
      liveConnected: this.isAvailable(),
    };
  }
}

/**
 * Groq provider (OpenAI-compatible REST endpoint). Configured when
 * GROQ_API_KEY is present. Registered in the ProviderRegistry so the Tool
 * Builder and orchestrator can be pointed at it without architectural
 * changes. Groq is the reasoning/engineering engine; Gemini Live stays the
 * conversational voice provider.
 */
export class GroqProvider implements AiProvider {
  readonly id = 'groq';
  readonly label = 'Groq';
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  setApiKey(key: string): void {
    this.apiKey = key;
  }

  isConfigured(): boolean {
    return typeof this.apiKey === 'string' && this.apiKey.trim().length > 0;
  }

  isAvailable(): boolean {
    return this.isConfigured();
  }

  sendMessage(text: string): void {
    // Groq has no live socket integration in this build; messages are queued
    // to the next generate() call by the orchestrator when it is the primary.
    logger.debug('[ai_provider] groq.sendMessage is best-effort; ignoring', { text: text.slice(0, 80) });
  }

  async generate(prompt: string, opts: GenerateOptions = {}): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? REST_TIMEOUT_DEFAULT_MS);
    try {
      const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey.trim()}`,
        },
        body: JSON.stringify({
          model: process.env.NOVA_GROQ_MODEL || 'llama-3.3-70b-versatile',
          messages: [
            {
              role: 'system',
              content:
                'You are NOVA, a secure desktop AI operating system. Follow the user instructions exactly. Execute clear action requests immediately without asking for confirmation or unnecessary details; choose sensible defaults.',
            },
            { role: 'user', content: prompt },
          ],
          max_tokens: opts.maxOutputTokens ?? 2048,
          temperature: 0.2,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(`Groq API error ${response.status}: ${body.slice(0, 300)}`);
      }
      const json = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const text = json.choices?.[0]?.message?.content ?? '';
      if (!text.trim()) throw new Error('Groq returned an empty completion.');
      return text.trim();
    } finally {
      clearTimeout(timer);
    }
  }

  describe(): Record<string, unknown> {
    return { id: this.id, configured: this.isConfigured() };
  }
}

export class AiProviderRegistry {
  private providers = new Map<string, AiProvider>();
  private priority: string[];

  constructor(priority: string[]) {
    this.priority = priority;
  }

  register(provider: AiProvider): void {
    this.providers.set(provider.id, provider);
  }

  get(id: string): AiProvider | undefined {
    return this.providers.get(id);
  }

  all(): AiProvider[] {
    return Array.from(this.providers.values());
  }

  /** Highest-priority provider that is configured (and available when required). */
  primary(requireAvailable = false): AiProvider | null {
    for (const id of this.priority) {
      const p = this.providers.get(id);
      if (!p) continue;
      if (!p.isConfigured()) continue;
      if (requireAvailable && !p.isAvailable()) continue;
      return p;
    }
    // Fall back to any configured provider.
    for (const p of this.providers.values()) {
      if (p.isConfigured() && (!requireAvailable || p.isAvailable())) return p;
    }
    return null;
  }

  /**
   * Pushes runtime secrets (from the vault) into the matching providers
   * without writing them into process.env — so they never leak to child
   * processes. Only providers that expose setApiKey are updated.
   */
  public configureSecrets(secrets: Record<string, string>): void {
    for (const [id, key] of Object.entries(secrets)) {
      const provider = this.providers.get(id);
      if (!provider || typeof key !== 'string' || !key) continue;
      const setter = (provider as unknown as { setApiKey?: (k: string) => void }).setApiKey;
      // Invoke as a method on the provider: extracting the function and calling
      // it bare loses `this`, so `this.apiKey = key` inside the setter would
      // throw (and abort secret bootstrap) instead of configuring the provider.
      if (typeof setter === 'function') setter.call(provider, key.trim());
    }
  }
}

function buildProviders(): { registry: AiProviderRegistry; gemini: GeminiLiveProvider } {
  const gemini = new GeminiLiveProvider(process.env.GEMINI_API_KEY ?? '');
  const registry = new AiProviderRegistry(NovaConfig.ai.providerPriority);
  registry.register(gemini);
  registry.register(new GroqProvider(process.env.GROQ_API_KEY ?? ''));
  return { registry, gemini };
}

const { registry: aiProviderRegistry, gemini: geminiProvider } = buildProviders();
export { aiProviderRegistry, geminiProvider };
