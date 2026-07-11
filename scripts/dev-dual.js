#!/usr/bin/env node
const { spawn } = require('child_process');

function run(command, args, opts = {}) {
  const p = spawn(command, args, { stdio: 'inherit', shell: true, env: { ...process.env, NODE_ENV: 'development' }, ...opts });
  p.on('exit', (code) => {
    if (code !== 0) {
      console.error(`${command} exited with code ${code}`);
    }
  });
  return p;
}

// Start the browser dev server and then launch Electron against the same 8080 URL.
run('npx', ['vite', '--config', 'vite.config.mts', '--host', '127.0.0.1', '--port', '8080']);

setTimeout(() => {
  const tsc = run('npx', ['tsc', '-p', 'tsconfig.main.json']);
  tsc.on('exit', (code) => {
    if (code === 0) {
      run('npx', ['electron', '.']);
    } else {
      console.error('TypeScript compilation failed; not launching Electron');
    }
  });
}, 1200);
