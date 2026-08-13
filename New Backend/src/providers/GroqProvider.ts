// New Backend — providers/GroqProvider.ts
// Groq reasoning/coding provider. A.D.A.M.'s intended reasoning/engineering head.
import type { AiProvider, GenerateOptions } from './ProviderTypes.js';
import { Nova2Config } from '../core/config.js';

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';

export class GroqProvider implements AiProvider {
  readonly id = 'groq';
  readonly label = 'Groq';
  private apiKey: string | null = null;

  configure(key: string | null): void {
    this.apiKey = key ? key.trim() : null;
  }

  isConfigured(): boolean {
    return Boolean(this.apiKey);
  }

  isAvailable(): boolean {
    return this.isConfigured();
  }

  async generate(prompt: string, opts: GenerateOptions = {}): Promise<string> {
    if (!this.apiKey) throw new Error('GROQ_API_KEY is not configured.');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? Nova2Config.providers.requestTimeoutMs);
    try {
      const response = await fetch(GROQ_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({
          model: Nova2Config.providers.groqModel,
          messages: [
            {
              role: 'system',
              content:
                'You are the reasoning, planning, engineering and tool-creation engine inside A.D.A.M. (Autonomous ' +
                'Digital Analytical Mind). You analyze goals, inspect the capabilities A.D.A.M. Core supplies, plan ' +
                'reliable solutions, design or repair tools when needed, and return precise, structured output. ' +
                'A.D.A.M. Core is the sole authority that executes physical actions on the user computer. Follow the ' +
                'requested output schema exactly.',
            },
            { role: 'user', content: prompt },
          ],
          max_tokens: opts.maxOutputTokens ?? 2048,
          temperature: opts.temperature ?? 0.2,
          stream: false,
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(`Groq API error ${response.status}: ${body.slice(0, 300)}`);
      }
      const json = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
      const text = json.choices?.[0]?.message?.content ?? '';
      if (!text.trim()) throw new Error('Groq returned an empty completion.');
      return text.trim();
    } finally {
      clearTimeout(timer);
    }
  }

  describe(): Record<string, unknown> {
    return { id: this.id, configured: this.isConfigured(), model: Nova2Config.providers.groqModel };
  }
}
