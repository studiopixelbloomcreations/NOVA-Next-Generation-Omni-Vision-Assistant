// Unit tests — Intent Engine (deterministic classification path).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IntentEngine } from '../../intent/IntentEngine.js';
import { PromptEngine } from '../../reasoning/PromptEngine.js';
import { InputEngine } from '../../input/InputEngine.js';
import type { AiProvider } from '../../providers/ProviderTypes.js';

const intent = new IntentEngine(new PromptEngine());
const input = new InputEngine();

function env(text: string) {
  return input.normalize(text, 'typed', { language: 'en' });
}

test('tool_creation intent detected for directory-analysis request', () => {
  const r = intent.classifyDeterministic('Create a tool that reports the largest files in a directory');
  assert.equal(r.kind, 'tool_creation');
  assert.equal(r.needsToolCreation, true);
});

test('research intent detected for news request', () => {
  const r = intent.classifyDeterministic('Research the latest developments in AI and summarize them');
  assert.equal(r.kind, 'informational');
  assert.equal(r.needsResearch, true);
});

test('computer_task intent for open calculator', () => {
  const r = intent.classifyDeterministic('Open Calculator');
  assert.equal(r.kind, 'computer_task');
});

test('conversational default for greeting', () => {
  const r = intent.classifyDeterministic('Hello there');
  assert.equal(r.kind, 'conversational');
});

test('envelope normalization strips secrets from transcript', () => {
  const e = env('my api key is sk-1234567890abcdef please remember it');
  assert.ok(!e.transcript.includes('sk-1234567890abcdef'));
});

test('AI-assisted classification used when provider configured', async () => {
  const fake: AiProvider = {
    id: 'fake',
    label: 'Fake',
    isConfigured: () => true,
    isAvailable: () => true,
    describe: () => ({}),
    async generate() {
      return '{"kind":"system_task","label":"shutdown","action":"system","entities":[],"needsResearch":false,"needsToolCreation":false,"confidence":0.9}';
    },
  };
  const r = await intent.classify(env('shut down the system'), fake);
  assert.equal(r.kind, 'system_task');
  assert.equal(r.confidence, 0.9);
});
