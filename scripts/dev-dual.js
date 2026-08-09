#!/usr/bin/env node
// Dev launcher for NOVA Genesis.
//
// NOVA is an Electron-only desktop application: there is no browser dev
// server, no localhost listener, and no web dashboard. This script compiles
// the main process and renderer, then launches Electron directly against the
// bundled files. Run with:
//
//   npm run dev:dual
//
const { spawn } = require('child_process');

function run(command, args, opts = {}) {
  const p = spawn(command, args, {
    stdio: 'inherit',
    shell: true,
    env: { ...process.env, NODE_ENV: 'development' },
    ...opts,
  });
  p.on('exit', code => {
    if (code !== 0 && !opts.ignoreFail) {
      console.error(`${command} exited with code ${code}`);
    }
  });
  return p;
}

// 1. Compile the main process (CommonJS -> dist/main).
const tsc = run('npx', ['tsc', '-p', 'tsconfig.main.json']);
tsc.on('exit', code => {
  if (code !== 0) {
    console.error('TypeScript (main) compilation failed; aborting');
    process.exit(1);
  }

  // 2. Bundle the renderer (Vite -> dist/renderer, no server).
  const vite = run('npx', ['vite', 'build', '--config', 'vite.config.mts']);
  vite.on('exit', viteCode => {
    if (viteCode !== 0) {
      console.error('Vite build failed; aborting');
      process.exit(1);
    }

    // 3. Launch Electron against the built output.
    const electron = run('npx', ['electron', '.'], { ignoreFail: true });
    electron.on('exit', () => process.exit(0));
  });
});

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
