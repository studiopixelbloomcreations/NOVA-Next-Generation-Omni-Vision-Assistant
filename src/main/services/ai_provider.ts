// src/main/services/ai_provider.ts
// Provider-agnostic AI orchestration layer.
// Gemini Live is NOVA's conversational/voice head. Groq is the reasoning,
// planning, engineering, and tool-synthesis engine. NOVA Core remains the
// execution authority; providers never directly own physical execution.
import { geminiLiveBridge } from './gemini_live_bridge';
import { logger } from '../core/logger';
import { NovaConfig } from '../core/config';

export interface GenerateOptions { timeoutMs?: number; maxOutputTokens?: number; }
export interface AiProvider {
  readonly id: string;
  readonly label: string;
  isConfigured(): boolean;
  isAvailable(): boolean;
  generate(prompt: string, opts?: GenerateOptions): Promise<string>;
  sendMessage?(text: string): void;
  describe(): Record<string, unknown>;
}

const REST_TIMEOUT_DEFAULT_MS = 30000;

function streamLiveText(prompt: string, timeoutMs: number): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    if (!geminiLiveBridge.isConnected() || !geminiLiveBridge.isSessionReady()) {
      reject(new Error('Gemini Live session is not ready.'));
      return;
    }
    let buffer = '';
    let lastTokenAt = Date.now();
    let settled = false;
    const onToken = (token: string): void => { if (!settled) { buffer += token; lastTokenAt = Date.now(); } };
    const watcher = setInterval(() => {
      if (!settled && Date.now() - lastTokenAt > 1200 && buffer.trim()) { cleanup(); resolve(buffer.trim()); }
    }, 250);
    const timeout = setTimeout(() => { if (!settled) { cleanup(); reject(new Error(`Gemini Live generation timed out after ${timeoutMs}ms`)); } }, timeoutMs);
    const cleanup = (): void => { settled = true; clearInterval(watcher); clearTimeout(timeout); geminiLiveBridge.removeListener('ai-text-token', onToken); };
    geminiLiveBridge.on('ai-text-token', onToken);
    try { geminiLiveBridge.sendTextMessage(prompt); } catch (err) { cleanup(); reject(err instanceof Error ? err : new Error(String(err))); }
  });
}

async function geminiRestGenerate(apiKey: string, prompt: string, opts: GenerateOptions): Promise<string> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${NovaConfig.ai.codegenModel}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? REST_TIMEOUT_DEFAULT_MS);
  try {
    const response = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: opts.maxOutputTokens ?? 2048, temperature: 0.2 } }),
      signal: controller.signal,
    });
    if (!response.ok) { const body = await response.text().catch(() => ''); throw new Error(`Gemini REST error ${response.status}: ${body.slice(0, 300)}`); }
    const json = (await response.json()) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
    const text = json.candidates?.[0]?.content?.parts?.map(p => p.text ?? '').join('') ?? '';
    if (!text.trim()) throw new Error('Gemini REST returned an empty completion.');
    return text.trim();
  } finally { clearTimeout(timer); }
}

export class GeminiLiveProvider implements AiProvider {
  readonly id = 'gemini';
  readonly label = 'Gemini Live';
  private apiKey: string;
  constructor(apiKey: string) { this.apiKey = apiKey; }
  setApiKey(key: string): void { this.apiKey = key; }
  isConfigured(): boolean { return typeof this.apiKey === 'string' && this.apiKey.trim().length > 0; }
  isAvailable(): boolean { return geminiLiveBridge.isConnected() && geminiLiveBridge.isSessionReady(); }
  sendMessage(text: string): void { geminiLiveBridge.sendTextMessage(text); }
  async generate(prompt: string, opts: GenerateOptions = {}): Promise<string> {
    const timeoutMs = opts.timeoutMs ?? NovaConfig.ai.requestTimeoutMs;
    if (this.isAvailable()) {
      try { return await streamLiveText(prompt, timeoutMs); }
      catch (err) { logger.warn('[ai_provider] Gemini Live generation failed; trying REST', { error: err instanceof Error ? err.message : String(err) }); }
    }
    return geminiRestGenerate(this.apiKey, prompt, opts);
  }
  describe(): Record<string, unknown> { return { id: this.id, configured: this.isConfigured(), liveConnected: this.isAvailable(), voice: NovaConfig.ai.liveVoice }; }
}

/** Groq reasoning/engineering provider. Gemini Live remains the voice/conversation head. */
export class GroqProvider implements AiProvider {
  readonly id = 'groq';
  readonly label = 'Groq';
  private apiKey: string;
  constructor(apiKey: string) { this.apiKey = apiKey; }
  setApiKey(key: string): void { this.apiKey = key; }
  isConfigured(): boolean { return typeof this.apiKey === 'string' && this.apiKey.trim().length > 0; }
  isAvailable(): boolean { return this.isConfigured(); }
  sendMessage(_text: string): void { /* NOVA Core owns turns; Groq is request/response reasoning only. */ }
  async generate(prompt: string, opts: GenerateOptions = {}): Promise<string> {
    if (!this.isConfigured()) throw new Error('GROQ_API_KEY is not configured.');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? REST_TIMEOUT_DEFAULT_MS);
    try {
      const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey.trim()}` },
        body: JSON.stringify({
          model: NovaConfig.ai.groqModel,
          messages: [
            { role: 'system', content: 'You are the reasoning and engineering engine inside NOVA Genesis. Analyze goals, inspect capabilities supplied by NOVA Core, plan reliable solutions, design or repair tools when needed, and return precise actionable plans. NOVA Core is the sole authority that executes physical actions on the user computer.' },
            { role: 'user', content: prompt },
          ],
          max_tokens: opts.maxOutputTokens ?? 2048,
          temperature: 0.2,
          stream: false,
        }),
        signal: controller.signal,
      });
      if (!response.ok) { const body = await response.text().catch(() => ''); throw new Error(`Groq API error ${response.status}: ${body.slice(0, 300)}`); }
      const json = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
      const text = json.choices?.[0]?.message?.content ?? '';
      if (!text.trim()) throw new Error('Groq returned an empty completion.');
      return text.trim();
    } finally { clearTimeout(timer); }
  }
  describe(): Record<string, unknown> { return { id: this.id, configured: this.isConfigured(), model: NovaConfig.ai.groqModel }; }
}

export class AiProviderRegistry {
  private providers = new Map<string, AiProvider>();
  private priority: string[];
  constructor(priority: string[]) { this.priority = priority; }
  register(provider: AiProvider): void { this.providers.set(provider.id, provider); }
  get(id: string): AiProvider | undefined { return this.providers.get(id); }
  all(): AiProvider[] { return Array.from(this.providers.values()); }
  primary(requireAvailable = false): AiProvider | null {
    for (const id of this.priority) { const p = this.providers.get(id); if (!p || !p.isConfigured()) continue; if (requireAvailable && !p.isAvailable()) continue; return p; }
    for (const p of this.providers.values()) if (p.isConfigured() && (!requireAvailable || p.isAvailable())) return p;
    return null;
  }
  configureSecrets(secrets: Record<string, string>): void {
    for (const [id, key] of Object.entries(secrets)) {
      const provider = this.providers.get(id);
      if (!provider || typeof key !== 'string' || !key) continue;
      const setter = (provider as unknown as { setApiKey?: (k: string) => void }).setApiKey;
      if (typeof setter === 'function') setter.call(provider, key.trim());
    }
  }
}

function buildProviders(): { registry: AiProviderRegistry; gemini: GeminiLiveProvider; groq: GroqProvider } {
  const gemini = new GeminiLiveProvider('');
  const groq = new GroqProvider('');
  const registry = new AiProviderRegistry(NovaConfig.ai.providerPriority);
  registry.register(gemini);
  registry.register(groq);
  return { registry, gemini, groq };
}

const { registry: aiProviderRegistry, gemini: geminiProvider, groq: groqProvider } = buildProviders();
export { aiProviderRegistry, geminiProvider, groqProvider };
