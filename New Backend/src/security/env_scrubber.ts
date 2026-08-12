// New Backend — security/env_scrubber.ts
// Scrubs API keys/secrets from the environment passed to any child process
// (Python sandbox, tool execution). Secrets never leak into subprocesses.
import { Nova2Config } from '../core/config.js';

export function scrubEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  const patterns = Nova2Config.security.secretScrubPatterns;
  for (const [k, v] of Object.entries(base)) {
    const upper = k.toUpperCase();
    if (patterns.some(p => upper.includes(p))) continue;
    env[k] = v;
  }
  return env;
}
