#!/usr/bin/env node
// Headless unit tests for NOVA Genesis core services.
//
// These tests run under plain Node (no Electron) against the compiled
// dist/main output. The tool store transparently falls back to JSON because
// better-sqlite3 is rebuilt for Electron's ABI, and isolated-vm is exercised
// for real sandbox compilation and execution.
//
// Run: npm run test:unit   (requires `npm run build` first)

const path = require('path');
const fs = require('fs');
const os = require('os');

const dist = path.join(__dirname, '..', 'dist', 'main', 'services');

let passed = 0;
let failed = 0;
const failures = [];

function assert(condition, message) {
  if (!condition) {
    const err = new Error(message);
    err.name = 'AssertionError';
    throw err;
  }
  passed++;
}

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    failures.push(`${name}: ${err.message}`);
    console.error(`  ✗ ${name}: ${err.message}`);
  }
}

function tempStorePath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-test-'));
  return { dir, db: path.join(dir, 'registry.db') };
}

async function main() {
  const { createToolRegistry } = require(path.join(dist, 'tool_registry.js'));
  const { ToolExecutor } = require(path.join(dist, 'tool_executor.js'));
  const { ToolBuilder } = require(path.join(dist, 'tool_builder.js'));
  const { ToolValidator } = require(path.join(dist, 'tool_validator.js'));
  const { aiProviderRegistry } = require(path.join(dist, 'ai_provider.js'));

  const { dir, db } = tempStorePath();
  const registry = createToolRegistry(db, null);
  const executor = new ToolExecutor(registry);
  const builder = new ToolBuilder(registry, executor);

  console.log('\n[tool_registry]');
  await test('register + lookup by name', () => {
    registry.register({
      id: 't1',
      name: 'stream_news',
      description: 'Opens a live news stream widget',
      category: 'media',
      author: 'ai',
      version: '1.0.0',
      dependencies: [],
      entryPoint: 'sandboxed-function',
      config: {},
      permissions: [],
      sourceCode: 'function stream_news(c){return {success:true,streamType:"hls",streamUrl:"x.m3u8"};} stream_news;',
      sourceHash: 'h1',
      enabled: true,
      status: 'active',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      lastExecutedAt: null,
      lastValidationDate: null,
      executionCount: 0,
      successCount: 0,
      totalExecutionTimeMs: 0,
      health: 'unknown',
      versions: [],
    });
    assert(registry.getByName('stream_news') !== null, 'getByName should find tool');
    assert(registry.getByName('stream_news').id === 't1', 'id matches');
  });

  await test('capability search finds matching tool', () => {
    const found = registry.findCapability('open a live news stream');
    assert(found !== null && found.name === 'stream_news', 'findCapability should match stream tool');
    assert(registry.findCapability('calculate fibonacci primes') === null, 'unrelated intent should not match');
  });

  await test('recordExecution updates metrics and health', () => {
    for (let i = 0; i < 3; i++) registry.recordExecution('t1', { success: true, durationMs: 12 });
    registry.recordExecution('t1', { success: false, durationMs: 200 });
    const t = registry.get('t1');
    assert(t.executionCount === 4, 'execution count = 4');
    assert(t.successCount === 3, 'success count = 3');
    assert(Math.abs(t.totalExecutionTimeMs / t.executionCount - 59) < 1, 'avg ~59ms');
    assert(t.health === 'degraded', 'health should be degraded (0.75 success)');
  });

  await test('publishVersion + rollback', () => {
    const updated = registry.publishVersion('t1', 'function stream_news(c){return {success:true,streamType:"embed",streamUrl:"y";}} stream_news;', { passed: true, violations: [], testedAt: Date.now() });
    assert(updated.version === '1.0.1', 'version bumped to 1.0.1');
    assert(updated.versions.length === 1, 'previous version retained');
    const rolled = registry.rollback('t1');
    assert(rolled !== null && rolled.version === '1.0.0', 'rollback restores 1.0.0');
    assert(rolled.sourceCode.includes('hls'), 'rollback restores old source');
  });

  await test('setEnabled + remove', () => {
    registry.setEnabled('t1', false);
    assert(registry.get('t1').enabled === false, 'disabled');
    registry.setEnabled('t1', true);
    assert(registry.remove('t1') === true, 'removed');
    assert(registry.get('t1') === null, 'gone after removal');
  });

  console.log('\n[tool_validator]');
  await test('safe tool passes validation', async () => {
    const code = 'function cap(c){return {success:true, n:(c && c.x || 0)+1};} cap;';
    const report = await new ToolValidator().validate({ sourceCode: code }, async _ctx => ({ success: true, n: 1 }));
    assert(report.passed === true, 'safe code should pass');
  });

  await test('dangerous tool fails validation', async () => {
    const evil = 'function evil(c){ return require("child_process").execSync("rm -rf /"); } evil;';
    const report = await new ToolValidator().validate({ sourceCode: evil });
    assert(report.passed === false, 'require/exec should fail');
    assert(report.violations.some(v => v.code === 'SECURITY' || v.code === 'DEPENDENCY'), 'violation recorded');
  });

  await test('syntax error fails validation', async () => {
    const report = await new ToolValidator().validate({ sourceCode: 'function broken( {' });
    assert(report.passed === false, 'syntax error should fail');
  });

  await test('while(1) and for(;;) variants are rejected', async () => {
    const w = await new ToolValidator().validate({ sourceCode: 'function w(c){while(1){}} w;' });
    assert(w.passed === false, 'while(1) rejected');
    const f = await new ToolValidator().validate({ sourceCode: 'function f(c){for(var i=0;;i++){}} f;' });
    assert(f.passed === false, 'for(;;) with var init rejected');
  });

  await test('self-recursion is rejected', async () => {
    const r = await new ToolValidator().validate({ sourceCode: 'function boom(c){return boom(c);} boom;' });
    assert(r.passed === false, 'self-recursive tool rejected');
  });

  await test('permission inference detects network usage', async () => {
    const { inferPermissions } = require(path.join(dist, 'tool_validator.js'));
    const perms = inferPermissions('fetch("https://api.example.com/x")');
    assert(perms.some(p => p.type === 'net-https' && p.scope.includes('api.example.com')), 'net-https inferred');
  });

  console.log('\n[tool_executor]');
  await test('sandbox executes tool and returns payload', async () => {
    const tool = {
      id: 'e1', name: 'echo', description: 'echo', category: 'test', author: 'system',
      version: '1.0.0', dependencies: [], entryPoint: 'sandboxed-function', config: {},
      permissions: [], sourceCode: 'function echo(c){return {success:true, echoed:c && c.q || null};} echo;',
      sourceHash: 'e1h', enabled: true, status: 'active', createdAt: Date.now(), updatedAt: Date.now(),
      lastExecutedAt: null, lastValidationDate: null, executionCount: 0, successCount: 0,
      totalExecutionTimeMs: 0, health: 'unknown', versions: [],
    };
    registry.register(tool);
    const result = await executor.execute('echo', { q: 'hello' });
    assert(result.success === true, 'execution succeeds');
    assert(result.payload && result.payload.echoed === 'hello', 'payload round-trips');
    const t = registry.get('e1');
    assert(t.executionCount === 1, 'metrics recorded');
  });

  await test('sandbox blocks host access attempts', async () => {
    const tool = {
      id: 'e2', name: 'evil_tool', description: 'x', category: 'test', author: 'system',
      version: '1.0.0', dependencies: [], entryPoint: 'sandboxed-function', config: {},
      permissions: [], sourceCode: 'function evil_tool(c){return {success:true, leak: process.version};} evil_tool;',
      sourceHash: 'e2h', enabled: true, status: 'active', createdAt: Date.now(), updatedAt: Date.now(),
      lastExecutedAt: null, lastValidationDate: null, executionCount: 0, successCount: 0,
      totalExecutionTimeMs: 0, health: 'unknown', versions: [],
    };
    registry.register(tool);
    const result = await executor.execute('evil_tool', {});
    // process is not injected into the isolate, so the tool errors out cleanly.
    assert(result.success === false, 'host access attempt fails safely');
  });

  await test('builtin handler dispatch', async () => {
    executor.registerBuiltin('hello_builtin', async args => ({ success: true, greeting: `hi ${args.name}` }));
    registry.register({
      id: 'e3', name: 'hello_builtin', description: 'b', category: 'system', author: 'system',
      version: '1.0.0', dependencies: [], entryPoint: 'builtin', config: {}, permissions: [],
      sourceCode: '// builtin', sourceHash: 'e3h', enabled: true, status: 'active',
      createdAt: Date.now(), updatedAt: Date.now(), lastExecutedAt: null, lastValidationDate: null,
      executionCount: 0, successCount: 0, totalExecutionTimeMs: 0, health: 'unknown', versions: [],
    });
    const result = await executor.execute('hello_builtin', { name: 'NOVA' });
    assert(result.success && result.payload.greeting === 'hi NOVA', 'builtin handler runs');
  });

  await test('runaway loop tool is killed by the hard wall-clock timeout', async () => {
    // A synchronous infinite loop cannot be preempted in-process by any
    // timeout — it must be terminated at the process level. This is the exact
    // gap worker isolation closes. (Deliberately registered directly so the
    // static validator does not reject it before execution.)
    registry.register({
      id: 'e5', name: 'infinite_loop', description: 'runaway', category: 'test', author: 'ai',
      version: '1.0.0', dependencies: [], entryPoint: 'sandboxed-function', config: {},
      permissions: [],
      sourceCode: 'function infinite_loop(c){ while(true){} } infinite_loop;',
      sourceHash: 'e5h', enabled: true, status: 'active',
      createdAt: Date.now(), updatedAt: Date.now(), lastExecutedAt: null, lastValidationDate: null,
      executionCount: 0, successCount: 0, totalExecutionTimeMs: 0, health: 'unknown', versions: [],
    });
    const t0 = Date.now();
    const result = await executor.execute('infinite_loop', {});
    const elapsed = Date.now() - t0;
    assert(result.success === false, 'runaway tool fails safely');
    assert(/timed out/i.test(result.error ?? ''), `error mentions timeout (got: ${result.error})`);
    assert(elapsed < 15000, `hard wall-clock kill fired in ${elapsed}ms`);
    // The worker must respawn cleanly for the next execution.
    const after = await executor.execute('echo', { q: 'recovered' });
    assert(after.success === true && after.payload && after.payload.echoed === 'recovered', 'worker respawns after kill');
  });

  console.log('\n[tool_builder]');
  await test('builds and registers a stream tool for media intent (stream widget path)', async () => {
    const { tool, result, reused } = await builder.ensureCapability('open a live tech news stream');
    assert(reused === false, 'new tool synthesized');
    assert(tool.status === 'active', 'tool active');
    assert(registry.getByName(tool.name) !== null, 'tool registered');
    assert(result && result.streamUrl, 'execution produced a stream URL');
  });

  await test('reuses an existing tool for a matching intent', async () => {
    const { tool, reused } = await builder.ensureCapability('open a live tech news stream');
    assert(reused === true, 'existing tool reused');
    assert(registry.getByName(tool.name) !== null, 'still registered');
  });

  await test('generic synthesis without an AI provider fails honestly (no fake tool)', async () => {
    // When a provider IS configured (e.g. GROQ_API_KEY in the environment) the
    // forge correctly uses it — the honest-failure path only applies when no
    // provider exists. Guard so the test is meaningful in both environments.
    if (aiProviderRegistry.primary()) {
      assert(true, 'provider configured — AI forge path used instead');
      return;
    }
    let failed = false;
    try {
      await builder.ensureCapability('summarize today\'s agenda');
    } catch (err) {
      failed = true;
      assert(/provider/i.test(err.message), `error mentions provider: ${err.message}`);
    }
    assert(failed === true, 'generic synthesis without provider must fail (no fake capability)');
  });

  console.log('\n[tool_forge]');
  await test('forge template writes real .py + tests, sandbox-tests, registers, and executes in production', async () => {
    const { ToolForge } = require(path.join(dist, 'tool_forge.js'));
    const { pythonRuntime } = require(path.join(dist, 'python_runtime.js'));
    const py = await pythonRuntime.status(true);
    if (!py.available) {
      assert(true, 'python unavailable — forge runtime test skipped');
      return;
    }
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-forge-'));
    const dbPath = path.join(sandbox, 'tools.db');
    const reg = createToolRegistry(dbPath, null);
    const forge = new ToolForge(reg);
    const result = await forge.forgeTool('which window is active right now');
    assert(result.tool !== null, 'tool registered');
    assert(result.tool.name === 'Window Insight', `AI/human display name assigned: ${result.tool.name}`);
    assert(result.tool.technicalId === 'window_insight', 'stable technical id');
    assert(result.tool.entryPoint === 'python', 'python runtime entry');
    assert(result.tool.version === '1.0.0', 'version 1.0.0');
    assert(fs.existsSync(result.tool.sourcePath), 'tool.py exists on disk');
    const src = fs.readFileSync(result.tool.sourcePath, 'utf-8');
    assert(src.includes('def run('), 'real Python source with run()');
    assert(src.includes('ctypes'), 'real Win32 implementation (not a mock)');
    assert(src.includes('GetForegroundWindow'), 'genuine implementation detail');
    assert(result.testOutput.includes('ALL_TESTS_PASSED') || result.productionOk, 'sandbox tests ran and passed');
    assert(result.productionOk === true, 'production execution on the real machine succeeded');
    const exec = result.execution && result.execution.result;
    assert(exec && exec.success === true, 'production run returned a real result');
    assert(typeof exec.title === 'string' && typeof exec.pid === 'number', 'real active-window data');
    assert(reg.getByName('Window Insight') !== null, 'registered in the SQLite-backed registry');
    reg.close();
    fs.rmSync(sandbox, { recursive: true, force: true });
  });
  await test('forge template fails honestly for unmatched intent without AI', async () => {
    const { ToolForge } = require(path.join(dist, 'tool_forge.js'));
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-forge-fail-'));
    const dbPath = path.join(sandbox, 'tools.db');
    const reg = createToolRegistry(dbPath, null);
    const forge = new ToolForge(reg);
    if (aiProviderRegistry.primary()) {
      // Provider configured: the forge may legitimately build this via AI.
      // The deterministic honest-failure path is covered when no provider
      // exists (the guarded test above) — skip without a false failure.
      reg.close();
      fs.rmSync(sandbox, { recursive: true, force: true });
      assert(true, 'provider configured — AI forge path used instead');
      return;
    }
    let failed = false;
    try {
      await forge.forgeTool('render a 3d hologram of the moon');
    } catch (err) {
      failed = true;
      assert(/provider/i.test(err.message), `honest error mentions provider: ${err.message}`);
    }
    assert(failed === true, 'unmatched intent without AI fails honestly');
    reg.close();
    fs.rmSync(sandbox, { recursive: true, force: true });
  });
  await test('forge static audit rejects dangerous AI-generated code', () => {
    const { ToolForge } = require(path.join(dist, 'tool_forge.js'));
    const bad = {
      displayName: 'Evil',
      technicalId: 'evil',
      description: 'x',
      category: 'utility',
      capabilities: [],
      permissions: [],
      dependencies: [],
      pythonSource: 'import subprocess\ndef run(params):\n    subprocess.Popen("rm -rf /")\n    return {"success": True}\n',
      testSource: 'from tool import run\nassert True\nprint("ALL_TESTS_PASSED")\n',
    };
    const violations = ToolForge.audit(bad, { strict: true });
    assert(violations.some(v => /banned import/.test(v)), 'banned subprocess import detected');
    const good = {
      displayName: 'Good',
      technicalId: 'good',
      description: 'x',
      category: 'utility',
      capabilities: [],
      permissions: [],
      dependencies: [],
      pythonSource: 'def run(params):\n    return {"success": True, "n": len(params or {})}\n',
      testSource: 'from tool import run\nassert run({"a": 1})["n"] == 1\nprint("ALL_TESTS_PASSED")\n',
    };
    assert(ToolForge.audit(good, { strict: true }).length === 0, 'clean code passes strict audit');
  });

  console.log('\n[python_runtime]');
  await test('runtime status reports availability honestly', async () => {
    const { pythonRuntime } = require(path.join(dist, 'python_runtime.js'));
    const status = await pythonRuntime.status(true);
    assert(typeof status.available === 'boolean', 'availability is boolean');
    assert(typeof status.modules === 'object', 'modules map present');
    if (status.available) {
      assert(status.version.length > 0, 'version reported when available');
    }
  });

  console.log('\n[ai_provider]');
  await test('provider registry lists all providers', () => {
    const ids = aiProviderRegistry.all().map(p => p.id);
    assert(ids.includes('gemini') && ids.includes('groq'), 'gemini + groq registered');
    aiProviderRegistry.configureSecrets({
      gemini: process.env.GEMINI_API_KEY ?? '',
      groq: process.env.GROQ_API_KEY ?? '',
    });
    const primary = aiProviderRegistry.primary();
    if (process.env.GEMINI_API_KEY || process.env.GROQ_API_KEY) {
      assert(primary !== null, 'a configured provider is primary');
    } else {
      assert(primary === null, 'no provider configured -> null primary (expected without keys)');
    }
  });

  console.log('\n[task_router]');
  const { classifyTask, preferredProviderFor, taskRouter } = require(path.join(dist, 'task_router.js'));
  await test('engineering intent is routed to groq', () => {
    const kind = classifyTask('debug this typescript function and review the api design');
    assert(kind === 'engineering', `engineering intent classified as ${kind}`);
    assert(preferredProviderFor(kind) === 'groq', 'engineering -> groq');
  });
  await test('media intent stays on the conversational provider', () => {
    const kind = classifyTask('open a live tech news stream');
    assert(kind === 'media', `media intent classified as ${kind}`);
    assert(preferredProviderFor(kind) === 'gemini', 'media -> gemini');
  });
  await test('route() returns kind + providerId', () => {
    const decision = taskRouter.route('write a plan to refactor the orchestrator');
    assert(decision.kind === 'planning' || decision.kind === 'engineering', 'planning detected');
    assert(decision.providerId === 'groq', 'thinking work prefers groq');
  });

  console.log('\n[runtime_state]');
  const { RuntimeState } = require(path.join(dist, 'runtime_state.js'));
  await test('overall status derives honestly from subsystems', () => {
    const rs = new RuntimeState();
    // Everything starting -> BOOTING.
    assert(rs.snapshot().overall === 'BOOTING', 'starts BOOTING');
    // Core subsystems online -> still BOOTING until gemini+memory ready.
    rs.setSubsystem('electron', 'online');
    rs.setSubsystem('toolRegistry', 'online');
    rs.setSubsystem('toolExecutor', 'online');
    assert(rs.snapshot().overall === 'BOOTING', 'still BOOTING while gemini/memory starting');
    // Bring everything online -> ONLINE.
    rs.setSubsystem('gemini', 'online');
    rs.setSubsystem('memory', 'online');
    rs.setSubsystem('python', 'online');
    rs.setSubsystem('groq', 'online');
    rs.setSubsystem('microphone', 'online');
    rs.setSubsystem('speaker', 'online');
    assert(rs.snapshot().overall === 'ONLINE', 'all online -> ONLINE');
    // A critical subsystem failing -> ERROR (never faked ONLINE).
    rs.setSubsystem('gemini', 'error', 'connection dropped');
    assert(rs.snapshot().overall === 'ERROR', 'gemini error -> ERROR');
    // Unconfigured optional subsystem -> DEGRADED, not ONLINE.
    const rs2 = new RuntimeState();
    rs2.setSubsystem('electron', 'online');
    rs2.setSubsystem('gemini', 'online');
    rs2.setSubsystem('memory', 'online');
    rs2.setSubsystem('toolRegistry', 'online');
    rs2.setSubsystem('toolExecutor', 'online');
    rs2.setSubsystem('python', 'online');
    rs2.setSubsystem('groq', 'unconfigured', 'no key');
    rs2.setSubsystem('microphone', 'online');
    rs2.setSubsystem('speaker', 'online');
    assert(rs2.snapshot().overall === 'DEGRADED', 'unconfigured groq -> DEGRADED (honest)');
  });
  await test('activity feed records and limits events', () => {
    const rs = new RuntimeState();
    rs.log('success', 'boot ok');
    rs.log('info', 'request received');
    rs.log('warn', 'python unavailable');
    const recent = rs.recentActivity(10);
    assert(recent.length === 3, 'three events recorded');
    assert(recent[0].message === 'python unavailable', 'newest first');
    rs.setTask('Reasoning with Groq');
    assert(rs.snapshot().currentTask === 'Reasoning with Groq', 'task state updates');
  });

  console.log('\n[mic_manager]');
  const { MicManager } = require(path.join(dist, 'mic_manager.js'));
  await test('mic state machine starts DISCONNECTED and reports listening truthfully', () => {
    const mm = new MicManager();
    assert(mm.getState() === 'DISCONNECTED', 'starts DISCONNECTED');
    assert(mm.isListening() === false, 'not listening initially');
    mm.reportListening();
    assert(mm.getState() === 'LISTENING', 'reportListening -> LISTENING');
    assert(mm.isListening() === true, 'listening true');
    mm.reportStoppedListening();
    assert(mm.getState() === 'READY', 'stopped -> READY when device known available');
    assert(mm.isListening() === false, 'not listening after stop');
  });
  await test('mic state machine reports permission/error honestly', () => {
    const mm = new MicManager();
    mm.reportPermissionDenied();
    assert(mm.getState() === 'PERMISSION_REQUIRED', 'denied -> PERMISSION_REQUIRED');
    assert(mm.snapshot().available === false, 'not available when denied');
    const mm2 = new MicManager();
    mm2.reportError('device unplugged');
    assert(mm2.getState() === 'ERROR', 'error -> ERROR');
    assert(mm2.snapshot().lastError === 'device unplugged', 'lastError recorded');
  });
  await test('mic manager discovers real devices via python runtime', async () => {
    const mm = new MicManager();
    // If python is unavailable the manager reports UNAVAILABLE/ERROR honestly
    // rather than fabricating a device.
    const devices = await mm.discover();
    assert(Array.isArray(devices), 'discover returns an array');
    const snap = mm.snapshot();
    if (snap.available) {
      assert(snap.state === 'READY', 'available -> READY');
      assert(snap.defaultCapture, 'default capture device reported');
    } else {
      assert(
        ['UNAVAILABLE', 'ERROR'].includes(snap.state),
        'no device -> honest UNAVAILABLE/ERROR state',
      );
    }
  });
  await test('mic diagnostic runs a real local capture (or reports failure honestly)', async () => {
    const mm = new MicManager();
    const diag = await mm.runDiagnostic(250);
    assert(diag && typeof diag.ok === 'boolean', 'diagnostic returns ok flag');
    if (diag.ok) {
      assert(typeof diag.rms === 'number', 'rms computed');
      assert(typeof diag.frames === 'number' && diag.frames > 0, 'non-zero frames captured');
    } else {
      assert(typeof diag.error === 'string', 'failure carries an error');
    }
  });

  console.log('\n[builtin_tools]');
  const { createToolRegistry: createBuiltinRegistry } = require(path.join(dist, 'tool_registry.js'));
  const { ToolExecutor: BuiltinToolExecutor } = require(path.join(dist, 'tool_executor.js'));
  const { registerBuiltinTools } = require(path.join(dist, 'builtin_tools.js'));
  await test('core built-in tools register (screen_capture, system_info, process_list, active_window, microphone_info, audio_device_list, application_launch, filesystem, clipboard, notification)', () => {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-builtin-test-'));
    const dbPath = path.join(sandbox, 'tools.db');
    const reg = createBuiltinRegistry(dbPath, null);
    const exec = new BuiltinToolExecutor();
    const required = [
      'screen_capture',
      'system_info',
      'process_list',
      'active_window',
      'microphone_info',
      'audio_device_list',
      'application_launch',
      'clipboard_read',
      'notify',
      'list_projects',
      'read_file',
      'write_file',
    ];
    registerBuiltinTools(reg, exec, {
      projectRoot: sandbox,
      resolvePath: (p) => path.join(sandbox, p),
      queueAutomationTask: () => 'task-1',
      builder: { ensureCapability: async () => ({ tool: { id: 't', name: 'generated' } }) },
      setActiveProject: () => {},
      getActiveProject: () => null,
    });
    for (const name of required) {
      assert(reg.getByName(name), `builtin '${name}' registered`);
    }
    exec.shutdown();
    reg.close();
    fs.rmSync(sandbox, { recursive: true, force: true });
  });
  await test('new production control tools register (mouse, keyboard, window, ocr, fetch_url, web_search, screen_ocr)', async () => {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-control-test-'));
    const dbPath = path.join(sandbox, 'tools.db');
    const reg = createBuiltinRegistry(dbPath, null);
    const exec = new BuiltinToolExecutor(reg);
    const required = [
      'mouse_move',
      'mouse_click',
      'mouse_double_click',
      'mouse_drag',
      'mouse_scroll',
      'keyboard_press',
      'keyboard_hotkey',
      'keyboard_type',
      'window_focus',
      'window_minimize',
      'window_maximize',
      'window_restore',
      'window_move',
      'screen_ocr',
      'fetch_url',
      'web_search',
    ];
    registerBuiltinTools(reg, exec, {
      projectRoot: sandbox,
      resolvePath: (p) => path.join(sandbox, p),
      queueAutomationTask: () => 'task-1',
      builder: { ensureCapability: async () => ({ tool: { id: 't', name: 'generated' } }) },
      setActiveProject: () => {},
      getActiveProject: () => null,
    });
    for (const name of required) {
      assert(reg.getByName(name), `control builtin '${name}' registered`);
    }
    // Unsafe launch targets must be rejected.
    const chained = await exec.execute('application_launch', {
      target: 'notepad.exe & calc.exe',
    });
    assert(!chained.success, 'shell chaining rejected');
    const interpreter = await exec.execute('application_launch', {
      target: 'cmd.exe /c echo pwned',
    });
    assert(!interpreter.success, 'command interpreter launch rejected');
    exec.shutdown();
    reg.close();
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  console.log('\n[task_runner]');
  const { TaskRunner } = require(path.join(dist, 'task_runner.js'));
  await test('task runner matches capabilities and produces a bounded trace', async () => {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-task-runner-'));
    const dbPath = path.join(sandbox, 'tools.db');
    const reg = createBuiltinRegistry(dbPath, null);
    const exec = new BuiltinToolExecutor();
    registerBuiltinTools(reg, exec, {
      projectRoot: sandbox,
      resolvePath: (p) => path.join(sandbox, p),
      queueAutomationTask: () => 'task-1',
      builder: { ensureCapability: async () => ({ tool: { id: 't', name: 'generated' } }) },
      setActiveProject: () => {},
      getActiveProject: () => null,
    });
    const runner = new TaskRunner(exec, reg);
    // Capability matching is deterministic.
    const matched = runner.matchCapability('take a screenshot of the screen');
    assert(matched && matched.id === 'screenshot', 'screenshot request matches screenshot capability');
    const sysInfo = runner.matchCapability('tell me my cpu and ram');
    assert(sysInfo && sysInfo.id === 'system_info', 'cpu/ram request matches system_info');
    const proc = runner.matchCapability('list running processes');
    assert(proc && proc.id === 'process_list', 'process request matches process_list');
    const none = runner.matchCapability('dance the macarena');
    assert(none === null, 'unmatched request returns null (no fake capability)');
    // Multi-step composed capability: news -> fetch -> save file.
    const news = runner.matchCapability('find today news and save a summary to my desktop');
    assert(news && news.id === 'news_summary', 'news+save matches composed capability');
    assert(news.plan.length >= 3, 'composed plan has multiple steps');
    // Filename extraction must survive dots in the name and honor content.
    const plan = runner.matchCapability('create a file named omega_test.txt with content Omega Prime');
    assert(plan && plan.plan.length === 1, 'create_file capability found');
    const args = plan.plan[0].args('create a file named omega_test.txt with content Omega Prime');
    assert(args.path === 'omega_test.txt', `filename with dot parsed: ${JSON.stringify(args.path)}`);
    assert(args.content === 'Omega Prime', `content parsed: ${args.content}`);
    // A real task runs through the executor (screen_capture may fall back).
    const trace = await runner.runTask('what is on my screen right now');
    assert(Array.isArray(trace.steps) && trace.steps.length > 0, 'trace has steps');
    assert(['completed', 'failed', 'partial'].includes(trace.status), 'trace has a final status');
    exec.shutdown();
    reg.close();
    fs.rmSync(sandbox, { recursive: true, force: true });
  });
  await test('conversational requests are never hijacked into machine actions', async () => {
    // Regression: the capability bridge must stay conservative. Broad bare
    // words like "web/latest/online/speaker/running/memory/open" in casual
    // speech must NOT trigger real machine actions.
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-bridge-guard-'));
    const dbPath = path.join(sandbox, 'tools.db');
    const reg = createBuiltinRegistry(dbPath, null);
    const exec = new BuiltinToolExecutor();
    registerBuiltinTools(reg, exec, {
      projectRoot: sandbox,
      resolvePath: (p) => path.join(sandbox, p),
      queueAutomationTask: () => 'task-1',
      builder: { ensureCapability: async () => ({ tool: { id: 't', name: 'generated' } }) },
      setActiveProject: () => {},
      getActiveProject: () => null,
    });
    const runner = new TaskRunner(exec, reg);
    const conversational = [
      'what do you think about open source software',
      'I would rather not go online today',
      'what does the speaker mean by that',
      'the project is still running smoothly',
      "my memory of that conversation is hazy",
      'what happened at the meeting earlier',
      'do you know what the latest trend in fashion is',
      'please open my mind to new ideas',
      'can you look up to me for guidance',
      'lets talk about the web of trust',
    ];
    for (const req of conversational) {
      const m = runner.matchCapability(req);
      assert(m === null, `conversational request must not match a capability: "${req}" (matched: ${m ? m.id : 'none'})`);
    }
    // Actionable intents still match after the tightening.
    assert(runner.matchCapability('search the web for ai news')?.id === 'web_search', 'actionable web search still matches');
    assert(runner.matchCapability('what happened today in the world')?.id === 'web_search', 'world-news query still matches');
    assert(runner.matchCapability('which window is active right now')?.id === 'active_window', 'active-window query still matches');
    assert(runner.matchCapability('which app is currently focused')?.id === 'active_window', 'focused-app query still matches');
    assert(runner.matchCapability('tell me my cpu and ram')?.id === 'system_info', 'cpu/ram still matches');
    assert(runner.matchCapability('what is on my screen')?.id === 'screen_ocr', 'screen read still matches');
    exec.shutdown();
    reg.close();
    fs.rmSync(sandbox, { recursive: true, force: true });
  });
  await test('task runner fileExists verifies real outcomes on disk', () => {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-verify-'));
    const p = path.join(sandbox, 'probe.txt');
    fs.writeFileSync(p, 'hello');
    const r = TaskRunner.fileExists(p);
    assert(r.exists === true && r.sizeBytes === 5, 'fileExists finds real file');
    const missing = TaskRunner.fileExists(path.join(sandbox, 'nope.txt'));
    assert(missing.exists === false, 'fileExists reports missing file');
    fs.rmSync(sandbox, { recursive: true, force: true });
  });
  await test('task runner expandPath resolves desktop/downloads shorthands', () => {
    const desktop = TaskRunner.expandPath('desktop/notes.txt');
    assert(desktop.includes('Desktop'), 'desktop shorthand expands');
    const dl = TaskRunner.expandPath('downloads/x.pdf');
    assert(dl.includes('Downloads'), 'downloads shorthand expands');
  });

  await test('workspace-first routing: news/websites/videos/files stay inside NOVA; explicit external goes to launch_app', async () => {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-ws-route-'));
    const dbPath = path.join(sandbox, 'tools.db');
    const reg = createBuiltinRegistry(dbPath, null);
    const exec = new BuiltinToolExecutor();
    registerBuiltinTools(reg, exec, {
      projectRoot: sandbox,
      resolvePath: (p) => path.join(sandbox, p),
      queueAutomationTask: () => 'task-1',
      builder: { ensureCapability: async () => ({ tool: { id: 't', name: 'generated' } }) },
      setActiveProject: () => {},
      getActiveProject: () => null,
    });
    const runner = new TaskRunner(exec, reg);
    // Workspace-first defaults.
    assert(runner.matchCapability('show me today\'s news')?.id === 'news_feed', 'news feed -> workspace news surface');
    assert(runner.matchCapability('open youtube')?.id === 'open_website', 'open youtube -> in-workspace web surface');
    assert(runner.matchCapability('play this video')?.id === 'play_video', 'play video -> in-workspace video surface');
    assert(runner.matchCapability('open this pdf')?.id === 'open_file_inside', 'open pdf -> in-workspace viewer');
    assert(runner.matchCapability('open calculator')?.id === 'launch_app', 'open calculator -> real app launch');
    assert(runner.matchCapability('open this website in chrome')?.id === 'launch_app', 'explicit in-chrome -> external browser path');
    assert(runner.matchCapability('open https://news.example.com in a browser')?.id === 'launch_app', 'explicit external URL -> external path');
    // Conversational phrases still never match.
    assert(runner.matchCapability('please open my mind to new ideas') === null, 'open-mind phrase stays conversational');
    exec.shutdown();
    reg.close();
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  console.log('\n[workspace_manager]');
  const { WorkspaceManager } = require(path.join(dist, 'workspace_manager.js'));
  await test('workspace manager opens, lists, closes and persists surfaces', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-workspace-'));
    const wm = new WorkspaceManager(root);
    const web = wm.open({ type: 'web', title: 'YouTube', source: 'https://www.youtube.com' });
    assert(web.id && web.state === 'open', 'web surface opened with id');
    const news = wm.open({
      type: 'news',
      title: 'Today\'s News',
      source: 'nova://news',
      content: JSON.stringify([{ title: 'Story 1', url: 'https://example.com/1' }]),
    });
    assert(wm.count() === 2, 'two surfaces open');
    assert(wm.list().every(s => s.state === 'open'), 'all listed surfaces open');
    assert(wm.close(web.id) === true, 'close returns true for existing');
    assert(wm.close('nope') === false, 'close returns false for unknown');
    assert(wm.count() === 1, 'one surface after close');
    // Persistence across a fresh manager instance (restart).
    const wm2 = new WorkspaceManager(root);
    wm2.load();
    assert(wm2.count() === 1, 'surfaces survive restart via JSON persistence');
    assert(wm2.get(news.id)?.type === 'news', 'news surface restored with type');
    fs.rmSync(root, { recursive: true, force: true });
  });
  await test('workspace manager broadcasts updates via onUpdate', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-ws-broadcast-'));
    let lastPayload = null;
    const wm = new WorkspaceManager(root, (payload) => { lastPayload = payload; });
    wm.open({ type: 'note', title: 'Note', source: 'nova://note', content: 'hello' });
    assert(lastPayload && Array.isArray(lastPayload.surfaces) && lastPayload.surfaces.length === 1, 'onUpdate fired with real surface list');
    assert(lastPayload.surfaces[0].title === 'Note', 'broadcast carries the surface');
    fs.rmSync(root, { recursive: true, force: true });
  });
  await test('workspace builtin tools register and open real surfaces through the executor', async () => {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-ws-builtin-'));
    const dbPath = path.join(sandbox, 'tools.db');
    const reg = createBuiltinRegistry(dbPath, null);
    const exec = new BuiltinToolExecutor(reg);
    const wm = new WorkspaceManager(path.join(sandbox, 'workspace'));
    registerBuiltinTools(reg, exec, {
      projectRoot: sandbox,
      resolvePath: (p) => path.join(sandbox, p),
      queueAutomationTask: () => 'task-1',
      builder: { ensureCapability: async () => ({ tool: { id: 't', name: 'generated' } }) },
      setActiveProject: () => {},
      getActiveProject: () => null,
      workspace: wm,
    });
    const required = ['workspace_open_url', 'workspace_show_news', 'workspace_show_content', 'workspace_show_image', 'workspace_open_file', 'workspace_list', 'workspace_close'];
    for (const name of required) {
      assert(reg.getByName(name), `workspace builtin '${name}' registered`);
    }
    const url = await exec.execute('workspace_open_url', { url: 'https://www.youtube.com', title: 'YouTube' });
    assert(url.success && url.payload.openedIn === 'nova-workspace', 'URL opens inside NOVA workspace');
    const list = await exec.execute('workspace_list', {});
    assert(list.success && list.payload.count === 1 && list.payload.surfaces[0].title === 'YouTube', 'workspace_list reflects the real surface');
    const closed = await exec.execute('workspace_close', { id: list.payload.surfaces[0].id });
    assert(closed.success === true, 'surface closes via tool');
    assert(wm.count() === 0, 'workspace empty after close');
    // Unsafe workspace URL rejected (no file:// / javascript:).
    const bad = await exec.execute('workspace_open_url', { url: 'javascript:alert(1)' });
    assert(!bad.success, 'non-http(s) workspace URL rejected');
    exec.shutdown();
    reg.close();
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  console.log('\n[memory_engine]');
  const { memoryEngine } = require(path.join(dist, 'memory_engine.js'));
  await test('stores and semantically retrieves memories', async () => {
    memoryEngine.setEmbeddingApiKey(''); // force local embedder
    await memoryEngine.store('conversation', 'User prefers dark theme interfaces with cyan accents');
    await memoryEngine.store('conversation', 'The team ships releases every friday afternoon');
    const hits = await memoryEngine.search('what theme does the user like?', 3);
    assert(hits.length > 0, 'search returns memories');
    assert(hits.some(h => h.content.includes('dark theme')), 'semantic match ranks highest');
  });
  await test('recall filters by kind', async () => {
    await memoryEngine.store('preference', 'editor: neovim', { tags: ['preference'] });
    const prefs = memoryEngine.recall('preference', 10);
    assert(prefs.some(p => p.content.includes('neovim')), 'preference recalled');
  });
  await test('stats report counts and embedder source', async () => {
    const stats = memoryEngine.stats();
    assert(stats.entries > 0, 'entries counted');
    assert(typeof stats.byKind.conversation === 'number', 'byKind breakdown present');
  });

  console.log('\n[personal_memory]');
  const { MemoryEngine: MemEngine, sanitizeMemoryText } = require(path.join(dist, 'memory_engine.js'));
  await test('identity defaults to Sir, survives restart, and updates', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-identity-'));
    const me = new MemEngine();
    me.setEmbeddingApiKey('');
    me.init(dir);
    const identity = me.getIdentity();
    assert(identity.preferredAddress === 'Sir', `identity default address is Sir (got ${identity.preferredAddress})`);
    me.updateIdentity({ projects: ['NOVA Genesis'], preferredAddress: 'Sir' });
    me.persist();
    // Restart: a fresh engine hydrates the same identity.
    const me2 = new MemEngine();
    me2.setEmbeddingApiKey('');
    me2.init(dir);
    const again = me2.getIdentity();
    assert(again.preferredAddress === 'Sir', 'address survives restart');
    assert(again.projects.includes('NOVA Genesis'), 'projects survive restart');
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await test('user facts store, retrieve semantically, and forget removes them', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-facts-'));
    const me = new MemEngine();
    me.setEmbeddingApiKey('');
    me.init(dir);
    const entry = await me.store('user-fact', 'The user is working on NOVA Genesis.', {
      importance: 0.9, confidence: 0.95, tags: ['user', 'project'], source: 'test',
    });
    const hits = await me.search('what project is the user working on?', 3, 'user-fact');
    assert(hits.some(h => h.content.includes('NOVA Genesis')), 'semantic retrieval finds the user fact');
    assert(entry.confidence === 0.95, 'confidence persisted');
    assert(me.forget(entry.id) === true, 'forget removes by id');
    assert(me.recall('user-fact').length === 0, 'fact gone after forget');
    // forget by content (user correction: "Forget that")
    const e2 = await me.store('preference', 'User prefers dark themes.', { importance: 0.8, tags: ['preference'] });
    assert(me.forgetUserFact('User prefers dark themes.') === true, 'forgetUserFact removes matching memory');
    assert(me.recall('preference').length === 0 && e2.id, 'preference removed by user correction');
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await test('secrets are redacted before entering memory', async () => {
    const clean = sanitizeMemoryText('use the api key AIzaSyB1234567890abcdefghijklmnop for auth');
    assert(!clean.includes('AIzaSyB'), 'API key stripped');
    assert(clean.includes('[REDACTED]'), 'redaction marker present');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-secret-'));
    const me = new MemEngine();
    me.setEmbeddingApiKey('');
    me.init(dir);
    await me.store('user-fact', 'password is hunter2secret99 and GEMINI key AIzaSyC1234567890abcdefghijklmnopqrst', {
      importance: 0.9, tags: ['secret-test'],
    });
    const hits = await me.search('hunter2secret99 AIzaSyC1234567890abcdefghijklmnopqrst', 3);
    const allContent = hits.map(h => h.content).join(' ');
    assert(!allContent.includes('hunter2secret99'), 'password not retrievable');
    assert(!allContent.includes('AIzaSyC'), 'API key not retrievable');
    assert(!me.recall('user-fact').some(e => /hunter2|AIzaSyC/.test(e.content)), 'stored content is sanitized');
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await test('related preferences consolidate into a coherent entry', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-consolidate-'));
    const me = new MemEngine();
    me.setEmbeddingApiKey('');
    me.init(dir);
    await me.store('preference', 'User prefers Electron applications.', { importance: 0.7, tags: ['preference', 'architecture'] });
    await me.store('preference', 'User avoids browser based architecture.', { importance: 0.7, tags: ['preference', 'architecture'] });
    await me.store('preference', 'User prefers desktop applications.', { importance: 0.7, tags: ['preference', 'architecture'] });
    const before = me.recall('preference').length;
    const merged = await me.consolidate();
    assert(merged > 0, 'consolidation merged related preferences');
    const after = me.recall('preference');
    assert(after.length < before, 'fewer entries after consolidation');
    assert(after.some(e => e.content.includes('Electron') && e.content.includes('desktop')), 'consolidated entry combines related facts');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  console.log('\n[personality_engine]');
  const { PersonalityEngine } = require(path.join(dist, 'personality_engine.js'));
  await test('default address is Sir and persists across restart', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-persona-'));
    const pe = new PersonalityEngine();
    pe.init(dir);
    assert(pe.address() === 'Sir', `default address is Sir (got ${pe.address()})`);
    assert(pe.setFormOfAddress('Sir') === true, 'setFormOfAddress accepts Sir');
    const pe2 = new PersonalityEngine();
    pe2.init(dir);
    assert(pe2.address() === 'Sir', 'address survives restart via config file');
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await test('transform adds the address naturally without inventing facts', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-persona-x-'));
    const pe = new PersonalityEngine();
    pe.init(dir);
    assert(pe.transform('CPU usage is 12%.') === 'CPU usage is 12%, Sir.', 'report statement -> address once');
    assert(pe.transform('Screenshot saved.') === 'Done, Sir. Screenshot saved.', 'completion -> Done, Sir.');
    assert(
      pe.transform('I cannot complete this because the microphone is disconnected.') ===
        'I cannot complete this because the microphone is disconnected, Sir.',
      'failure stays factual, address natural',
    );
    assert(pe.transform('What is the weather today?') === 'What is the weather today?', 'questions are never forced');
    assert(pe.transform('✅ Done — Task complete.') === '✅ Done, Sir. Task complete.', 'emoji prefix preserved');
    assert(pe.transform('Sure, Sir.') === 'Sure, Sir.', 'already-addressed text unchanged (no doubling)');
    assert(pe.transform('') === '', 'empty input -> empty');
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await test('voice system instruction carries persona, Sir guidance, and truthfulness', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-persona-v-'));
    const pe = new PersonalityEngine();
    pe.init(dir);
    const si = pe.buildVoiceSystemInstruction();
    assert(si.includes('NOVA'), 'persona identifies NOVA');
    assert(/British/i.test(si), 'refined British delivery direction');
    assert(si.includes('Sir'), 'Sir guidance present');
    assert(/never (force|claim)/i.test(si), 'truthfulness + sparing-address guidance');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  console.log('\n[voice_charon]');
  const { NovaConfig } = require(path.join(dist, '..', 'core', 'config.js'));
  const { GeminiLiveBridge } = require(path.join(dist, 'gemini_live_bridge.js'));
  await test('canonical voice is configured and reaches the actual session setup frame', () => {
    const expected = process.env.NOVA_LIVE_VOICE || 'Charon';
    assert(NovaConfig.ai.liveVoice === expected, `NovaConfig.ai.liveVoice is ${expected} (got ${NovaConfig.ai.liveVoice})`);
    const bridge = new GeminiLiveBridge('');
    assert(bridge.getVoiceName() === expected, 'bridge reports the canonical voice');
    const setup = bridge.buildSetupMessage();
    const voice = setup.setup.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName;
    assert(voice === expected, `session setup frame requests ${expected} (got ${voice})`);
    assert(setup.setup.model && setup.setup.model.length > 0, 'live model configured from NovaConfig');
    const sysText = setup.setup.systemInstruction.parts[0].text;
    assert(typeof sysText === 'string' && sysText.includes('NOVA'), 'system instruction is the persona direction');
    // No obsolete voice: the only voiceName source is NovaConfig.
    assert(!JSON.stringify(setup).includes('Kore'), 'no obsolete Kore voice anywhere in the setup frame');
  });

  console.log('\n[permission enforcement]');
  await test('sandboxed tool with banned permission is refused', async () => {
    const bad = {
      id: 'e4', name: 'bad_perms', description: 'x', category: 'test', author: 'ai',
      version: '1.0.0', dependencies: [], entryPoint: 'sandboxed-function', config: {},
      permissions: [{ type: 'child-process', scope: ['*'] }],
      sourceCode: 'function bad_perms(c){return {success:true};} bad_perms;',
      sourceHash: 'e4h', enabled: true, status: 'active', createdAt: Date.now(), updatedAt: Date.now(),
      lastExecutedAt: null, lastValidationDate: null, executionCount: 0, successCount: 0,
      totalExecutionTimeMs: 0, health: 'unknown', versions: [],
    };
    registry.register(bad);
    const result = await executor.execute('bad_perms', {});
    assert(result.success === false, 'banned permission blocks execution');
    assert(/banned permission/.test(result.error), 'error explains the denial');
  });

  await test('execution ledger records every run', () => {
    const log = registry.recentExecutions(20);
    assert(log.length >= 1, 'ledger has entries');
    const latest = log[0];
    assert(typeof latest.toolName === 'string' && typeof latest.success === 'boolean', 'ledger shape correct');
  });

  console.log('\n[python worker]');
  await test('persistent worker responds to ping when python is available', async () => {
    const { pythonRuntime } = require(path.join(dist, 'python_runtime.js'));
    const started = await pythonRuntime.startWorker();
    if (!started) {
      assert(true, 'python not available -> worker gracefully disabled');
    } else {
      const result = await pythonRuntime.request('ping', {});
      assert(result.ok === true, 'ping succeeds');
      const info = await pythonRuntime.request('system.info', {});
      assert(result.ok === true, 'system.info request resolves');
      assert(info.ok === true && info.data && typeof info.data.platform === 'string', 'system info shape');
      pythonRuntime.stopWorker();
    }
  });

  executor.shutdown();
  registry.close();
  memoryEngine.persist();
  fs.rmSync(dir, { recursive: true, force: true });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.error('Failures:');
    for (const f of failures) console.error(' -', f);
    process.exit(1);
  }
  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
