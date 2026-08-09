// scripts/e2e-smoke.js
// Simple smoke test: runs after `npm run build` in CI. Uses fallback synthesis
// path (no GEMINI_API_KEY) to generate a tool and exercise handleToolCall.

const path = require('path');
const fs = require('fs');

// Renderer bundle guard: the packaged window loads the emitted HTML via
// loadFile, so a path regression would ship a blank window that no other
// automated check catches. Verify the HTML exists at one of the candidate
// layouts and that every asset it references actually resolves.
function verifyRendererBundle() {
  const htmlCandidates = [
    path.join(__dirname, '..', 'dist', 'renderer', 'index.html'),
    path.join(__dirname, '..', 'dist', 'renderer', 'src', 'renderer', 'index.html'),
  ];
  const html = htmlCandidates.find(p => fs.existsSync(p));
  if (!html) {
    console.error('[e2e-smoke] renderer index.html missing (loadFile path regression)');
    process.exit(5);
  }
  const content = fs.readFileSync(html, 'utf-8');
  const refs = [...content.matchAll(/(?:src|href)="([^"]+\.(?:js|css))"/g)].map(m => m[1]);
  for (const ref of refs) {
    const resolved = path.resolve(path.dirname(html), ref);
    if (!fs.existsSync(resolved)) {
      console.error('[e2e-smoke] renderer asset missing:', ref);
      process.exit(6);
    }
  }
  console.log('[e2e-smoke] renderer bundle OK:', path.relative(process.cwd(), html));
}

async function run() {
  try {
    verifyRendererBundle();

    // Load compiled agent orchestrator from dist
    const agentPath = path.join(__dirname, '..', 'dist', 'main', 'services', 'agent_orchestrator.js');
    const orchestratorModule = require(agentPath);
    const agentOrchestrator = orchestratorModule.agentOrchestrator;

    if (!agentOrchestrator) {
      console.error('agentOrchestrator not found in compiled output at', agentPath);
      process.exit(2);
    }

    console.log('[e2e-smoke] Generating tool from intent (fallback path)...');
    const tool = await agentOrchestrator.generateToolFromIntent('open a live tech news stream');
    console.log('[e2e-smoke] Tool generated:', { id: tool.id, name: tool.name, status: tool.status });

    if (tool.status !== 'compiled') {
      console.error('[e2e-smoke] Tool was not compiled successfully');
      process.exit(3);
    }

    // Construct a mock toolCall payload similar to Gemini Live's shape
    const toolCall = {
      functionCalls: [
        {
          id: 'test-fc-1',
          name: tool.name,
          args: { query: 'latest technology headlines' },
        },
      ],
    };

    console.log('[e2e-smoke] Invoking handleToolCall with mock payload...');
    const responses = await agentOrchestrator.handleToolCall(toolCall);
    console.log('[e2e-smoke] handleToolCall responses:', responses);

    if (!Array.isArray(responses) || responses.length === 0) {
      console.error('[e2e-smoke] No responses from handleToolCall');
      process.exit(4);
    }

    console.log('[e2e-smoke] Smoke test passed');
    process.exit(0);
  } catch (err) {
    console.error('[e2e-smoke] Error during smoke test:', err);
    process.exit(1);
  }
}

run();
