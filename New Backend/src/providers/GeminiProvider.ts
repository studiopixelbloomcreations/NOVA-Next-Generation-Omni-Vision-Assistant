// New Backend — providers/GeminiProvider.ts
// Gemini provider. Gemini Live is A.D.A.M.'s conversational/audio head; Gemini
// REST is used as a coding/reasoning fallback when Groq is unavailable.
import type { AiProvider, GenerateOptions } from './ProviderTypes.js';
import { Nova2Config } from '../core/config.js';

export class GeminiProvider implements AiProvider {
  readonly id = 'gemini';
  readonly label = 'Gemini';
  private apiKey: string | null = null;

  /** If a Gemini Live bridge is supplied, it becomes the conversational path. */
  constructor(private liveBridge?: { isConnected(): boolean; sendTextMessage(text: string): void }) {}

  configure(key: string | null): void {
    this.apiKey = key ? key.trim() : null;
  }

  isConfigured(): boolean {
    return Boolean(this.apiKey);
  }

  isAvailable(): boolean {
    return this.isConfigured();
  }

  private async restGenerate(prompt: string, opts: GenerateOptions): Promise<string> {
    if (!this.apiKey) throw new Error('GEMINI_API_KEY is not configured.');
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${Nova2Config.providers.geminiCodegenModel}:generateContent?key=${encodeURIComponent(this.apiKey)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? Nova2Config.providers.requestTimeoutMs);
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { maxOutputTokens: opts.maxOutputTokens ?? 2048, temperature: opts.temperature ?? 0.2 },
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(`Gemini REST error ${response.status}: ${body.slice(0, 300)}`);
      }
      const json = (await response.json()) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
      const text = json.candidates?.[0]?.content?.parts?.map(p => p.text ?? '').join('') ?? '';
      if (!text.trim()) throw new Error('Gemini returned an empty completion.');
      return text.trim();
    } finally {
      clearTimeout(timer);
    }
  }

  async generate(prompt: string, opts: GenerateOptions = {}): Promise<string> {
    return this.restGenerate(prompt, opts);
  }

  describe(): Record<string, unknown> {
    return { id: this.id, configured: this.isConfigured(), codegenModel: Nova2Config.providers.geminiCodegenModel };
  }
}
