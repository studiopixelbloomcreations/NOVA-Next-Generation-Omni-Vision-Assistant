#!/usr/bin/env node
// NOVA New Backend — autonomous end-to-end demo.
// Runs the full master loop against a REAL directory: intent -> environment ->
// capability discovery -> planning -> Tool Forge (real Python) -> sandbox test
// -> registration -> production execution -> verification -> memory -> result.
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NovaBackend } from '../dist/index.js';

async function main() {
  // Point the backend at the real python_runtime (the demo chdir's below).
  process.env.NOVA2_PYTHON_RUNTIME_ROOT = fileURLToPath(new URL('../python_runtime', import.meta.url));
  // Isolated data dir so the demo never touches a real NOVA profile.
  const work = mkdtempSync(join(tmpdir(), 'nova-demo-'));
  process.chdir(work);

  const downloads = join(work, 'Downloads');
  mkdirSync(downloads);
  writeFileSync(join(downloads, 'README.txt'), 'quick note');
  writeFileSync(join(downloads, 'photo.jpg'), 'j'.repeat(120000));
  writeFileSync(join(downloads, 'invoice.pdf'), 'p'.repeat(20000));
  writeFileSync(join(downloads, 'setup.exe'), 's'.repeat(450000));

  const backend = new NovaBackend({ logLevel: 'info' });
  await backend.start();

  console.log('\n==============================================================');
  console.log('USER: ADAM. Analyze my Downloads folder and tell me which file is the largest.');
  console.log('==============================================================\n');

  const result = await backend.handleRequest(
    `Analyze my Downloads folder and tell me which file is the largest`,
    'typed',
  );

  const entry = result.entry;
  console.log(`Intent      : ${entry.intent?.kind ?? 'n/a'} (${entry.intent?.label ?? ''})`);
  console.log(`Plan        : ${entry.plan?.steps.length ?? 0} step(s) -> ${entry.plan?.goal ?? ''}`);
  console.log(`Status      : ${result.status}`);
  console.log(`Summary     : ${result.summary}`);
  for (let i = 0; i < entry.steps.length; i++) {
    const s = entry.steps[i];
    console.log(
      `  Step ${i + 1}: ${s.step.goal.slice(0, 60)} | tool=${s.tool?.displayName ?? 'n/a'} | success=${s.success} | verified=${s.verification.passed}`,
    );
  }
  const payload = result.payloads[0];
  if (payload && typeof payload === 'object' && 'largestFile' in payload) {
    const lf = payload.largestFile;
    console.log(`\nRESULT: largest file is "${lf.name}" (${lf.sizeBytes} bytes).`);
  }
  console.log(`Latency     : ${entry.latencyMs}ms`);

  console.log('\nPersisted capabilities:');
  for (const c of backend.listCapabilities()) console.log(`  - ${c.name} [${c.category}] (${c.technicalId})`);

  await backend.shutdown();
  console.log('\nDemo complete. Data dir: ' + work);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
