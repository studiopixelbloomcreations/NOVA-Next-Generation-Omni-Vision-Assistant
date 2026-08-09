// BISECT HARNESS — requires the real app modules in import order and logs
// the first module that throws. Temporarily replaces dist/main/main.js in the
// installed app. The real entry is backed up to main.real.js by the deploy script.
const fs = require('fs');
const path = require('path');

const logFile = path.join(process.env.TEMP || process.cwd(), 'bisect.log');
const log = m => {
  try {
    fs.appendFileSync(logFile, m + '\n');
  } catch {
    /* ignore */
  }
};

log('BISECT start ' + new Date().toISOString() + ' pid=' + process.pid);

const mods = [
  '../shared/ipc_protocols',
  './ingestors/screen_capturer',
  './ingestors/voice_processor',
  './ingestors/wake_word_detector',
  './services/context_engine',
  './services/gemini_live_bridge',
  './services/agent_orchestrator',
  './db/sqlite_adapter',
  './db/graph_engine',
  './services/dream_mode',
  './services/specialized_modes/meeting_mode',
  './services/specialized_modes/live_coding_mode',
  './services/specialized_modes/creative_studio',
  './services/life_replay',
  './services/intent_forecaster',
  './utils/security',
  './services/ipc_firewall',
  './services/secret_store',
  './core/logger',
  './core/config',
  './services/audit_logger',
  './services/windows_integration',
  './services/ai_provider',
  './services/task_router',
  './services/memory_engine',
];

for (const m of mods) {
  try {
    require(m);
    log('OK ' + m);
  } catch (e) {
    const stack = e && e.stack ? e.stack.split('\n').slice(0, 5).join(' | ') : String(e);
    log('THROW ' + m + ' :: ' + stack);
    process.exit(2);
  }
}
log('ALL MODULES OK — loading real main');
try {
  require('./main.real.js');
  log('MAIN LOADED OK');
} catch (e) {
  const stack = e && e.stack ? e.stack.split('\n').slice(0, 8).join(' | ') : String(e);
  log('MAIN THROW :: ' + stack);
  process.exit(3);
}
