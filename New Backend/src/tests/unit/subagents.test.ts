// Unit tests — Agent Orchestrator subagents (bounded, disposable, aggregated).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentOrchestrator } from '../../orchestration/AgentOrchestrator.js';
import { AgentSelector } from '../../reasoning/AgentSelector.js';
import { ProviderRegistry } from '../../providers/ProviderRegistry.js';

test('subagents are bounded, resolved, and disposed', async () => {
  const registry = new ProviderRegistry();
  const selector = new AgentSelector(registry);
  const orch = new AgentOrchestrator(selector, 5000);

  // Fake provider that returns a conclusion quickly.
  const fake = {
    id: 'fake', label: 'Fake', isConfigured: () => true, isAvailable: () => true, describe: () => ({}),
    async generate() { return 'The approach is sound but the timeout is too low.'; },
  };
  registry.register(fake as never);

  const arch = await orch.runSubagent('architecture', 'audit the forge pipeline', fake as never);
  assert.equal(arch.done, true);
  assert.ok(arch.conclusion && arch.conclusion.includes('timeout'));

  const qa = await orch.runSubagent('qa', 'check tests', fake as never);
  const agg = orch.aggregate([arch, qa]);
  assert.ok(agg.includes('[architecture]'));
  assert.equal(orch.activeSubagents().length, 0, 'subagents are disposed after completion');
  orch.disposeAll();
});

test('subagent times out gracefully (bounded) without a provider', async () => {
  const registry = new ProviderRegistry();
  const selector = new AgentSelector(registry);
  const orch = new AgentOrchestrator(selector, 2000);
  const sub = await orch.runSubagent('security', 'is this safe?', null);
  assert.equal(sub.done, true, 'always resolves, never hangs');
  orch.disposeAll();
});
